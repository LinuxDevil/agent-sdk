# Utilities

Supporting helpers exported from the `@lousho/build-ai-agent/utils` subpath:
encryption and hashing, and file storage for attachments. None of them is
needed to build an agent; they are here for the apps around one.

## Encryption and hashing

```ts
import { EncryptionUtils, sha256 } from '@lousho/build-ai-agent/utils';

const encryption = new EncryptionUtils('your-secret-key');
const encrypted = await encryption.encrypt('sensitive data'); // fresh random salt every call
const decrypted = await encryption.decrypt(encrypted);        // throws DecryptionError on tampering

const hash = await sha256('password', 'salt');
```

`encrypt()` generates a random salt per call, so ciphertext written by
releases before that change cannot be decrypted and must be re-encrypted (see
the [CHANGELOG](../CHANGELOG.md)).

## File storage

`StorageService` keeps files for one user under a named folder. The `fs` and
`path` modules are injected as adapters, and the Node modules satisfy them
as-is. It is also what `StorageServiceApprovalStore` and
`LocalStorageCheckpointStore` write through.

```ts
import { StorageService } from '@lousho/build-ai-agent/utils';
import * as fs from 'node:fs';
import * as path from 'node:path';

// fs/path are injected as adapters; the Node modules satisfy them as-is.
const storage = new StorageService('user-123', 'attachments', fs, path);

await storage.savePlainTextAttachment('Report contents', 'report.txt'); // UTF-8 text
await storage.saveAttachmentFromBase64('JVBERi0xLjQK', 'document.pdf'); // base64 -> binary
// `saveAttachment(file, ...)` is for the browser: its first argument is a `File`
// (it awaits file.arrayBuffer()).
const bytes = storage.readAttachment('document.pdf'); // synchronous; an ArrayBuffer, not a Node Buffer
storage.deleteAttachment('document.pdf');
```
