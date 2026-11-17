"""The forge proxy's CA: a name-constrained root sandboxes trust, and the per-host leaf certificates it signs."""

from __future__ import annotations

import datetime as dt
import os
import re
import ssl
import tempfile
import threading
from dataclasses import dataclass

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

_CA_LIFETIME = dt.timedelta(days=3650)
_LEAF_LIFETIME = dt.timedelta(days=30)
_LEAF_RENEW_BEFORE = dt.timedelta(days=7)


@dataclass(frozen=True)
class CaMaterial:
    cert_pem: bytes
    key_pem: bytes


def generate_ca(hosts: list[str]) -> CaMaterial:
    """A new CA that can only certify `hosts` (and their subdomains), so its key cannot impersonate anything else."""
    if not hosts:
        raise ValueError("a forge CA needs at least one host")
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Scooter"),
        x509.NameAttribute(NameOID.COMMON_NAME, "Scooter forge proxy CA"),
    ])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + _CA_LIFETIME)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=True,
                crl_sign=True, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.NameConstraints(
                permitted_subtrees=[x509.DNSName(h) for h in sorted(set(hosts))],
                excluded_subtrees=None,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return CaMaterial(
        cert_pem=cert.public_bytes(serialization.Encoding.PEM),
        key_pem=key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )


def split_pem(pem: bytes) -> list[bytes]:
    """Each PEM block in a bundle, in order."""
    return re.findall(rb"-----BEGIN [^-]+-----.*?-----END [^-]+-----\n?", pem, re.S)


def ca_hosts(cert_pem: bytes) -> list[str]:
    """The hosts a CA's name constraints permit."""
    cert = x509.load_pem_x509_certificate(cert_pem)
    try:
        nc = cert.extensions.get_extension_for_class(x509.NameConstraints).value
    except x509.ExtensionNotFound:
        return []
    return sorted(n.value for n in (nc.permitted_subtrees or []) if isinstance(n, x509.DNSName))


def _permits(constraint: str, host: str) -> bool:
    return host == constraint or host.endswith("." + constraint)


class LeafIssuer:
    """Server-side SSLContexts for intercepted hosts, each with a leaf signed by the CA whose constraints cover it, cached until near expiry."""

    def __init__(self, *cas: CaMaterial) -> None:
        if not cas:
            raise ValueError("a leaf issuer needs at least one CA")
        self._cas = [
            (x509.load_pem_x509_certificate(ca.cert_pem), serialization.load_pem_private_key(ca.key_pem, password=None), ca_hosts(ca.cert_pem))
            for ca in cas
        ]
        self._leaf_key = ec.generate_private_key(ec.SECP256R1())
        self._contexts: dict[str, tuple[ssl.SSLContext, dt.datetime]] = {}
        self._lock = threading.Lock()
        # load_cert_chain reads only files, so leaves are written to a private directory.
        self._dir = tempfile.mkdtemp(prefix="forge-leaf-")
        os.chmod(self._dir, 0o700)

    def context_for(self, host: str) -> ssl.SSLContext:
        now = dt.datetime.now(dt.timezone.utc)
        with self._lock:
            cached = self._contexts.get(host)
            if cached and cached[1] - now > _LEAF_RENEW_BEFORE:
                return cached[0]
            ctx, not_after = self._issue(host, now)
            self._contexts[host] = (ctx, not_after)
            return ctx

    def _issue(self, host: str, now: dt.datetime) -> tuple[ssl.SSLContext, dt.datetime]:
        ca_cert, ca_key, _ = next(
            (ca for ca in self._cas if any(_permits(c, host) for c in ca[2])), self._cas[0],
        )
        not_after = now + _LEAF_LIFETIME
        leaf = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
            .issuer_name(ca_cert.subject)
            .public_key(self._leaf_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(not_after)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),  # type: ignore[arg-type]
                critical=False,
            )
            .sign(ca_key, hashes.SHA256())  # type: ignore[arg-type]
        )
        chain = os.path.join(self._dir, f"{host}.pem")
        keyfile = os.path.join(self._dir, "leaf.key")
        with open(keyfile, "wb") as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(self._leaf_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ))
        with open(chain, "wb") as f:
            f.write(leaf.public_bytes(serialization.Encoding.PEM))
            f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(chain, keyfile)
        # The proxy speaks HTTP/1.1 only, so h2-capable clients (gh, glab) must not negotiate h2.
        ctx.set_alpn_protocols(["http/1.1"])
        return ctx, not_after
