import { describe, expect, test } from 'bun:test';

import {
  attachmentFromBase64,
  attachmentLabel,
  attachmentLimitBytes,
  attachmentMimeForName,
  attachmentPromptFile,
  detectAttachmentMime,
  formatBytes,
  makeAttachment,
  pastedPath,
  splitPastedPaths,
} from './attachment.ts';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('attachment mime detection', () => {
  test('maps supported extensions only', () => {
    expect(attachmentMimeForName('shot.PNG')).toBe('image/png');
    expect(attachmentMimeForName('scan.jpeg')).toBe('image/jpeg');
    expect(attachmentMimeForName('doc.pdf')).toBe('application/pdf');
    expect(attachmentMimeForName('notes.txt')).toBeUndefined();
    expect(attachmentMimeForName('noext')).toBeUndefined();
  });

  test('recognizes image and PDF magic bytes, not arbitrary binary', () => {
    expect(detectAttachmentMime(png)).toBe('image/png');
    expect(detectAttachmentMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectAttachmentMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(detectAttachmentMime(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    const webp = new TextEncoder().encode('RIFF0000WEBP');
    expect(detectAttachmentMime(webp)).toBe('image/webp');
    expect(detectAttachmentMime(new Uint8Array([0, 1, 2, 3]))).toBeUndefined();
    expect(detectAttachmentMime(new TextEncoder().encode('hello'))).toBeUndefined();
  });
});

describe('makeAttachment', () => {
  test('encodes bytes as base64 and records the size', () => {
    const result = makeAttachment('shot.png', 'image/png', png, 'a1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toEqual({
      id: 'a1',
      name: 'shot.png',
      mime: 'image/png',
      data: Buffer.from(png).toString('base64'),
      size: png.byteLength,
    });
  });

  test('rejects unsupported types, empty data and oversize files', () => {
    expect(makeAttachment('a.txt', 'text/plain', png).ok).toBe(false);
    expect(makeAttachment('a.png', 'image/png', new Uint8Array()).ok).toBe(false);
    const oversize = new Uint8Array(attachmentLimitBytes + 1);
    expect(makeAttachment('a.png', 'image/png', oversize).ok).toBe(false);
  });

  test('a prompt file is an inline data URI, readable by a remote server', () => {
    const result = makeAttachment('shot.png', 'image/png', png, 'a1');
    if (!result.ok) throw new Error(result.error);
    const file = attachmentPromptFile(result.attachment);
    expect(file).toEqual({
      uri: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
      name: 'shot.png',
    });
  });

  test('rebuilds an attachment from a queued message payload', () => {
    const data = Buffer.from(png).toString('base64');
    expect(attachmentFromBase64('shot.png', 'image/png', data, 'a1')).toEqual({
      id: 'a1',
      name: 'shot.png',
      mime: 'image/png',
      data,
      size: png.byteLength,
    });
    expect(attachmentFromBase64('a.txt', 'text/plain', data, 'a1')).toBeUndefined();
    expect(attachmentFromBase64('a.png', 'image/png', '', 'a1')).toBeUndefined();
  });

  test('labels show name and size', () => {
    const result = makeAttachment('shot.png', 'image/png', png, 'a1');
    if (!result.ok) throw new Error(result.error);
    expect(attachmentLabel(result.attachment)).toBe('shot.png · 11 B');
    expect(formatBytes(1536)).toBe('1.5 kB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('pasted paths', () => {
  test('handles quotes, file URLs and windows paths', () => {
    expect(pastedPath('"C:\\shots\\a.png"', 'win32')).toBe('C:\\shots\\a.png');
    expect(pastedPath('file:///C:/shots/a.png', 'win32')).toBe('C:\\shots\\a.png');
    expect(pastedPath('file://localhost/tmp/a.png', 'linux')).toBe('/tmp/a.png');
    expect(pastedPath('/tmp/a\\ b.png', 'linux')).toBe('/tmp/a b.png');
  });

  test('splits multiple quoted paths and keeps plain text intact', () => {
    expect(splitPastedPaths('"/tmp/a b.png" /tmp/c.png', 'linux')).toEqual([
      '/tmp/a b.png',
      '/tmp/c.png',
    ]);
    expect(splitPastedPaths('fix the flaky test', 'linux')).toEqual([
      'fix',
      'the',
      'flaky',
      'test',
    ]);
    // An unbalanced quote is not a file-list paste.
    expect(splitPastedPaths('"unterminated', 'linux')).toEqual([]);
  });

  test('non-file URL schemes are not treated as local paths', () => {
    expect(pastedPath('https://example.com/a.png', 'linux')).toBe('https://example.com/a.png');
    expect(pastedPath('file:///tmp/a%2Fb.png', 'linux')).toBe('file:///tmp/a%2Fb.png');
  });
});
