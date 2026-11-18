/**
 * Composer attachments for images and PDFs. OpenCode accepts these as `data:` URIs on the
 * prompt, so the bytes travel with the request and a remote server never needs access to a
 * path on this machine. Binary clipboard data is never inserted into the text draft.
 */

import { baseServerPath } from './server-path.ts';

export type Attachment = Readonly<{
  id: string;
  name: string;
  mime: string;
  /** Base64 payload without the `data:` prefix. */
  data: string;
  /** Decoded size in bytes. */
  size: number;
}>;

/** Matches the upstream TUI's per-paste staging budget. */
export const attachmentLimitBytes = 20 * 1024 * 1024;

const mimeByExtension: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const supportedMimes = new Set(Object.values(mimeByExtension));

export function attachmentMimeForName(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return mimeByExtension[name.slice(dot).toLowerCase()];
}

export function isSupportedAttachmentMime(mime: string): boolean {
  return supportedMimes.has(mime);
}

type Signature = Readonly<{ mime: string; bytes: readonly number[] }>;

const signatures: readonly Signature[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/** MIME from magic bytes for the formats a terminal may hand us as raw data. */
export function detectAttachmentMime(bytes: Uint8Array): string | undefined {
  for (const signature of signatures) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) return signature.mime;
  }
  // RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export type AttachmentResult = { ok: true; attachment: Attachment } | { ok: false; error: string };

/** Builds an attachment from captured bytes, rejecting unsupported types and oversize data. */
export function makeAttachment(
  name: string,
  mime: string,
  bytes: Uint8Array,
  id: string = crypto.randomUUID(),
): AttachmentResult {
  if (!isSupportedAttachmentMime(mime)) {
    return { ok: false, error: `Unsupported attachment type ${mime || 'unknown'}` };
  }
  if (bytes.byteLength === 0) return { ok: false, error: 'The attachment is empty' };
  if (bytes.byteLength > attachmentLimitBytes) {
    return {
      ok: false,
      error: `The attachment is larger than ${formatBytes(attachmentLimitBytes)}`,
    };
  }
  return {
    ok: true,
    attachment: {
      id,
      name: name === '' ? 'attachment' : name,
      mime,
      data: Buffer.from(bytes).toString('base64'),
      size: bytes.byteLength,
    },
  };
}

/** The prompt file this attachment becomes; a `data:` URI keeps it readable for any server. */
export function attachmentPromptFile(
  attachment: Attachment,
): Readonly<{ uri: string; name: string }> {
  return {
    uri: `data:${attachment.mime};base64,${attachment.data}`,
    name: attachment.name,
  };
}

/** Rebuilds an attachment from a server-reported inline prompt file (queued message). */
export function attachmentFromBase64(
  name: string,
  mime: string,
  data: string,
  id: string,
): Attachment | undefined {
  if (!isSupportedAttachmentMime(mime)) return undefined;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = Math.floor((data.length * 3) / 4) - padding;
  if (size <= 0 || size > attachmentLimitBytes) return undefined;
  return { id, name: name === '' ? 'attachment' : name, mime, data, size };
}

export function attachmentLabel(attachment: Attachment): string {
  return `${attachment.name} · ${formatBytes(attachment.size)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeFileUrl(value: string, platform: NodeJS.Platform): string | undefined {
  if (!value.startsWith('file://')) return undefined;
  try {
    const url = new URL(value);
    if (/%2f|%5c/i.test(url.pathname)) return undefined;
    const pathname = decodeURIComponent(url.pathname);
    if (platform !== 'win32') {
      if (url.hostname !== '' && url.hostname !== 'localhost') return undefined;
      return pathname;
    }
    const local = pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\');
    return url.hostname === '' || url.hostname === 'localhost'
      ? local
      : `\\\\${url.hostname}${local}`;
  } catch {
    return undefined;
  }
}

/** Turns one pasted token into a local path (quotes and `file://` removed). */
export function pastedPath(value: string, platform: NodeJS.Platform): string {
  const raw = value.replace(/^['"]+|['"]+$/g, '');
  const url = decodeFileUrl(raw, platform);
  if (url !== undefined) return url;
  if (platform === 'win32') return raw;
  return raw.replace(/\\(.)/g, '$1');
}

/** Splits a multi-file paste; quoted paths may contain whitespace. */
export function splitPastedPaths(text: string, platform: NodeJS.Platform): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quote !== '') {
      if (character === quote) quote = '';
      else if (character === '\\' && platform !== 'win32' && index + 1 < text.length) {
        current += text[index + 1] ?? '';
        index += 1;
      } else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\\' && platform !== 'win32' && index + 1 < text.length) {
      current += text[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== '') tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (quote !== '') return [];
  if (current !== '') tokens.push(current);
  return tokens.map((token) => pastedPath(token, platform));
}

/** Display name for a pasted path, correct for both server path shapes. */
export function pastedAttachmentName(path: string): string {
  return baseServerPath(path);
}
