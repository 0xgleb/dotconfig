# Input ergonomics threat model

## Boundaries and assets

- Interactive editor text is untrusted until it is parsed as one exact temporary
  screenshot path.
- Filesystem metadata and bytes are untrusted even when the path has an image
  extension.
- Protected assets are arbitrary local files, filesystem paths, credentials in
  nearby temporary files, model context size, and user clipboard contents.

## Controls

- Only exact absolute image paths under macOS `/var/folders/.../T/` or
  `/var/folders/.../TemporaryItems/` are candidates. Sentences containing paths,
  traversal, home/Desktop paths, and other extensions are ignored.
- Symlinks are resolved before reading and the resolved path is checked against
  the same allowlist.
- The target must be a non-empty regular file no larger than 20 MiB.
- PNG, JPEG, GIF, and WebP magic bytes must match the declared extension.
- Successful transforms attach bounded base64 image data and replace the path
  with a generic prompt, so the model never receives the filesystem location.
- Failed candidates are handled with a UI error instead of forwarding the path
  to the model or attempting a broader read.

## STRIDE summary

| Threat | Control |
| --- | --- |
| Spoofing | Extension and magic bytes must agree |
| Tampering | Realpath, regular-file, size, and signature validation happen before attachment |
| Repudiation | UI notification reports successful attachment or explicit rejection |
| Information disclosure | Narrow temporary roots and path removal prevent arbitrary-file/path exposure |
| Denial of service | 20 MiB hard limit bounds reads and model payloads |
| Elevation of privilege | No shell, command execution, or arbitrary path action is exposed |
