# `tf-vars` — decrypt, edit, and re-encrypt terraform.tfvars.
# `resolve-identity` / `infra-recipients` come from lib.nu (concatenated at build).

def main [--identity (-i): string] {
  cd $"($env.HOME)/.config/infra"

  let id = (resolve-identity $identity)
  let recipients = (infra-recipients)

  # Wrap the whole plaintext lifecycle so the rm always runs, even if the
  # editor or rage encryption fails — never leave decrypted secrets on disk.
  let failed = (try {
    if not ("terraform.tfvars.age" | path exists) {
      cp terraform.tfvars.example terraform.tfvars
    } else {
      ^rage -d -i $id -o terraform.tfvars terraform.tfvars.age
    }

    let editor = ($env.EDITOR? | default "nvim")
    ^$editor terraform.tfvars

    # Atomic swap: encrypt to a temp file, then rename over the real .age, so a
    # failed encryption can't truncate the only ciphertext copy (the freshly
    # hand-edited secrets here aren't in git yet — losing them is unrecoverable).
    $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age.tmp terraform.tfvars
    mv -f terraform.tfvars.age.tmp terraform.tfvars.age
    false
  } catch {
    true
  })

  rm -f terraform.tfvars terraform.tfvars.age.tmp
  if $failed { exit 1 }
}
