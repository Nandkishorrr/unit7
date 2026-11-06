# Homebrew formula, for a tap. Fill in url and sha256 from a tagged release.
class Unit7 < Formula
  desc "Runs your servers, and tells the truth about them"
  homepage "https://github.com/Nandkishorrr/unit7"
  url "https://github.com/Nandkishorrr/unit7/archive/refs/tags/v2.0.0.tar.gz"
  sha256 "REPLACE_ME"
  depends_on "node"

  def install
    system "npm", "ci", "--omit=dev"
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/unit7.mjs" => "unit7"
  end
end
