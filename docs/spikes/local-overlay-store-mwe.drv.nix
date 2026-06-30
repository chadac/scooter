let sys = "x86_64-linux";
in {
  lower = derivation { name = "lower-pkg"; system = sys; builder = "/bin/sh"; args = [ "-c" "echo from-lower > $out" ]; };
  upper = derivation { name = "upper-pkg"; system = sys; builder = "/bin/sh"; args = [ "-c" "echo built-in-upper > $out" ]; };
}
