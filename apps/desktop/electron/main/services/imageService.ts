import { dialog, nativeImage } from 'electron';
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { nowIso, uuidv7 } from '@pos/shared';
import { AppError } from '../errors.js';
import { photosDir } from '../paths.js';
import { findItemById } from '../db/repos/itemRepo.js';
import { writeAudit } from './auditService.js';

/**
 * Item photos and the shop logo.
 *
 * Pictures are the path into the catalogue for anyone who has not memorised the
 * codes, which on the browse screen is most new staff.
 *
 * Every image is re-encoded to a sensible size on the way in. A phone photo is
 * four megabytes and 4000 pixels wide; a shelf tile needs neither, and a
 * database folder full of them would make every backup slow and large.
 */

const MAX_EDGE = 512;
const LOGO_MAX_EDGE = 400;
const JPEG_QUALITY = 78;

/** Ask for a picture file. Returns null when the person cancels. */
export async function chooseImage(title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function shrink(sourcePath: string, maxEdge: number): Buffer {
  if (!existsSync(sourcePath)) {
    throw new AppError('not_found', 'That picture could not be found.');
  }

  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) {
    throw new AppError('not_an_image', `${basename(sourcePath)} is not a picture file.`);
  }

  const { width, height } = image.getSize();
  const longest = Math.max(width, height);
  const resized =
    longest > maxEdge
      ? image.resize({
          width: Math.round((width / longest) * maxEdge),
          height: Math.round((height / longest) * maxEdge),
          quality: 'good',
        })
      : image;

  return resized.toJPEG(JPEG_QUALITY);
}

/** Store a picture against an item, replacing any it already had. */
export function setItemPhoto(
  db: BetterSqlite3.Database,
  itemId: string,
  sourcePath: string,
  userId: string,
): { photoPath: string } {
  const item = findItemById(db, itemId);
  if (!item) throw new AppError('not_found', 'That item no longer exists.');

  const bytes = shrink(sourcePath, MAX_EDGE);
  const name = `${uuidv7()}.jpg`;
  const path = join(photosDir(), name);
  writeFileSync(path, bytes);

  db.transaction(() => {
    db.prepare(`UPDATE items SET photo_path = ?, updated_at = ? WHERE id = ?`).run(
      name,
      nowIso(),
      itemId,
    );
    writeAudit(db, {
      userId,
      action: 'item.photo',
      entity: 'item',
      entityId: itemId,
      summary: `Added a picture for ${item.name}`,
    });
  })();

  removeFile(item.photoPath);
  return { photoPath: name };
}

export function clearItemPhoto(
  db: BetterSqlite3.Database,
  itemId: string,
  userId: string,
): { ok: true } {
  const item = findItemById(db, itemId);
  if (!item) throw new AppError('not_found', 'That item no longer exists.');

  db.transaction(() => {
    db.prepare(`UPDATE items SET photo_path = NULL, updated_at = ? WHERE id = ?`).run(
      nowIso(),
      itemId,
    );
    writeAudit(db, {
      userId,
      action: 'item.photo_remove',
      entity: 'item',
      entityId: itemId,
      summary: `Removed the picture for ${item.name}`,
    });
  })();

  removeFile(item.photoPath);
  return { ok: true };
}

/**
 * A stored picture as a data URL.
 *
 * Data URLs rather than a file:// path, because the renderer runs under a
 * Content-Security-Policy that allows no file access — and should keep doing so.
 * Tiles ask for these one at a time and the renderer caches them.
 */
export function readPhoto(name: string | null): string | null {
  if (!name) return null;
  const path = name.includes('/') || name.includes('\\') ? name : join(photosDir(), name);
  try {
    if (!existsSync(path)) return null;
    return `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Store the shop logo. Kept as an absolute path, since receipts read it directly. */
export function setShopLogo(sourcePath: string): { logoPath: string } {
  const bytes = shrink(sourcePath, LOGO_MAX_EDGE);
  const path = join(photosDir(), 'shop-logo.jpg');
  writeFileSync(path, bytes);
  return { logoPath: path };
}

function removeFile(name: string | null): void {
  if (!name) return;
  try {
    const path = name.includes('/') || name.includes('\\') ? name : join(photosDir(), name);
    if (existsSync(path) && !path.endsWith('shop-logo.jpg')) unlinkSync(path);
  } catch {
    // An orphaned picture costs a few kilobytes; failing the save would cost
    // the shop the change they were making.
  }
}
