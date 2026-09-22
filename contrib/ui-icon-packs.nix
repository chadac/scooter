# The react-icons packs a contrib may draw an icon from.
#
# Fixed set, not "any string": a contrib cannot add an npm dependency (ui/
# default.nix pins npmDepsHash, so a contrib-local dep would change the UI's
# lockfile and make "add a contrib = a new directory" false again), so its icon
# has to come from a pack the UI already resolves. Why: PR #601.
{
  si = "react-icons/si";
  fa = "react-icons/fa";
  fa6 = "react-icons/fa6";
  fi = "react-icons/fi";
  md = "react-icons/md";
}
