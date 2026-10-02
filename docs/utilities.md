# Utilities

Supporting helpers exported from the package root: encryption and hashing,
and file storage for attachments. None of them is needed
to build an agent; they are here for the apps around one.

## Encryption and hashing

```ts
import { EncryptionUtils, sha256 } from '@lousho/build-ai-agent';

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
import { StorageService } from '@lousho/build-ai-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';

// fs/path are injected as adapters (LOU-A7); the Node modules satisfy them as-is.
const storage = new StorageService('user-123', 'attachments', fs, path);

await storage.saveAttachment(file, 'document.pdf');
const buffer = storage.readAttachment('document.pdf');
storage.deleteAttachment('document.pdf');
```
