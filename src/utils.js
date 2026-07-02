export const MAX_IMAGE_SIDE = 1800;
export const THUMB_SIZE = 520;
export const IMAGE_QUALITY = 0.82;
export const THUMB_QUALITY = 0.72;

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function uid(prefix = '') {
  const fallback = '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (char) => {
    const random = crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(1))[0] : Math.floor(Math.random() * 256);
    return (Number(char) ^ (random & (15 >> (Number(char) / 4)))).toString(16);
  });
  const id = crypto.randomUUID ? crypto.randomUUID() : fallback;
  return prefix ? `${prefix}-${id}` : id;
}

export function nowIso() {
  return new Date().toISOString();
}

export function toDatetimeLocal(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
}

export function fromDatetimeLocal(value) {
  if (!value) return nowIso();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

export function formatDate(value, options = {}) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  if (options.numeric === true) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const base = `${day}/${month}/${year}`;
    if (!options.timeStyle) return base;
    const time = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(date);
    return `${base} ${time}`;
  }
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: options.dateStyle || 'medium',
    timeStyle: options.timeStyle
  }).format(date);
}

export function formatDateRange(start, end, options = {}) {
  const left = start ? formatDate(start, { numeric: true }) : '';
  const right = end ? formatDate(end, { numeric: true }) : '';
  if (left && right && left !== right) return `${left} - ${right}`;
  return left || right || options.fallback || 'ยังไม่ระบุวัน';
}

export function formatDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'ไม่ระบุวันที่';
  return date.toISOString().slice(0, 10);
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function parseTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function tagsToString(tags) {
  return Array.isArray(tags) ? tags.join(', ') : '';
}

export function sortByDateDesc(items, field = 'visited_at') {
  return [...items].sort((a, b) => new Date(b[field] || b.updated_at || 0) - new Date(a[field] || a.updated_at || 0));
}

export function countUnique(items, field) {
  return new Set(items.map((item) => item[field]).filter(Boolean)).size;
}

export function bytesToSize(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function downloadFile(filename, content, mimeType = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Cannot read file'));
    reader.readAsDataURL(file);
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Cannot read blob'));
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}


function safeDateFromFile(file) {
  const value = Number(file?.lastModified || 0);
  if (!Number.isFinite(value) || value <= 0) return nowIso();
  try {
    return new Date(value).toISOString();
  } catch (_) {
    return nowIso();
  }
}

function compressionRatio(originalBytes = 0, compressedBytes = 0) {
  const original = Number(originalBytes || 0);
  const compressed = Number(compressedBytes || 0);
  if (!original || !compressed) return null;
  return Math.max(0, Math.min(1, 1 - (compressed / original)));
}

export function photoSizeLabel(photo = {}) {
  const width = Number(photo.width || 0);
  const height = Number(photo.height || 0);
  const size = Number(photo.size_bytes || 0);
  const parts = [];
  if (width && height) parts.push(`${width}x${height}`);
  if (size) parts.push(bytesToSize(size));
  return parts.join(' · ');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Cannot load image'));
    img.src = src;
  });
}

function calculateSize(width, height, maxSide) {
  const largest = Math.max(width, height);
  if (largest <= maxSide) return { width, height };
  const scale = maxSide / largest;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = IMAGE_QUALITY) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function resizeToBlob(image, maxSide, quality) {
  const size = calculateSize(image.naturalWidth || image.width, image.naturalHeight || image.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, size.width, size.height);
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  return { blob, width: size.width, height: size.height };
}


function readUInt16(view, offset, littleEndian) {
  return view.getUint16(offset, littleEndian);
}

function readUInt32(view, offset, littleEndian) {
  return view.getUint32(offset, littleEndian);
}

function readAscii(view, offset, length) {
  let output = '';
  for (let i = 0; i < length; i += 1) {
    const code = view.getUint8(offset + i);
    if (!code) break;
    output += String.fromCharCode(code);
  }
  return output;
}

function readRational(view, offset, littleEndian, signed = false) {
  const num = signed ? view.getInt32(offset, littleEndian) : view.getUint32(offset, littleEndian);
  const den = signed ? view.getInt32(offset + 4, littleEndian) : view.getUint32(offset + 4, littleEndian);
  if (!den) return null;
  return num / den;
}

function readExifValue(view, tiffStart, entryOffset, littleEndian) {
  const type = readUInt16(view, entryOffset + 2, littleEndian);
  const count = readUInt32(view, entryOffset + 4, littleEndian);
  const valueOffset = entryOffset + 8;
  const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const byteCount = (typeSizes[type] || 1) * count;
  const dataOffset = byteCount <= 4 ? valueOffset : tiffStart + readUInt32(view, valueOffset, littleEndian);
  if (dataOffset < 0 || dataOffset >= view.byteLength) return null;
  if (type === 2) return readAscii(view, dataOffset, count);
  if (type === 3) return count === 1 ? readUInt16(view, dataOffset, littleEndian) : Array.from({ length: count }, (_, i) => readUInt16(view, dataOffset + i * 2, littleEndian));
  if (type === 4) return count === 1 ? readUInt32(view, dataOffset, littleEndian) : Array.from({ length: count }, (_, i) => readUInt32(view, dataOffset + i * 4, littleEndian));
  if (type === 5) return count === 1 ? readRational(view, dataOffset, littleEndian) : Array.from({ length: count }, (_, i) => readRational(view, dataOffset + i * 8, littleEndian));
  if (type === 9) return count === 1 ? view.getInt32(dataOffset, littleEndian) : Array.from({ length: count }, (_, i) => view.getInt32(dataOffset + i * 4, littleEndian));
  if (type === 10) return count === 1 ? readRational(view, dataOffset, littleEndian, true) : Array.from({ length: count }, (_, i) => readRational(view, dataOffset + i * 8, littleEndian, true));
  return null;
}

function readIfdEntries(view, tiffStart, ifdOffset, littleEndian) {
  const entries = new Map();
  const absolute = tiffStart + ifdOffset;
  if (absolute < 0 || absolute + 2 > view.byteLength) return entries;
  const count = readUInt16(view, absolute, littleEndian);
  for (let i = 0; i < count; i += 1) {
    const entryOffset = absolute + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = readUInt16(view, entryOffset, littleEndian);
    entries.set(tag, readExifValue(view, tiffStart, entryOffset, littleEndian));
  }
  return entries;
}

function parseExifDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function gpsDmsToDecimal(value, ref) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const decimal = Number(value[0] || 0) + Number(value[1] || 0) / 60 + Number(value[2] || 0) / 3600;
  if (!Number.isFinite(decimal)) return null;
  return ['S', 'W'].includes(String(ref || '').trim().toUpperCase()) ? -decimal : decimal;
}


function parseXmpGpsDecimal(text) {
  const clean = String(text || '').replace(/&quot;/g, '"');
  const pairs = [
    [/GPSLatitude[\s:="]+([+-]?\d+(?:\.\d+)?)/i, /GPSLongitude[\s:="]+([+-]?\d+(?:\.\d+)?)/i],
    [/exif:GPSLatitude="([^"]+)"/i, /exif:GPSLongitude="([^"]+)"/i],
    [/<exif:GPSLatitude>([^<]+)<\/exif:GPSLatitude>/i, /<exif:GPSLongitude>([^<]+)<\/exif:GPSLongitude>/i]
  ];
  for (const [latRe, lngRe] of pairs) {
    const latMatch = clean.match(latRe);
    const lngMatch = clean.match(lngRe);
    if (!latMatch || !lngMatch) continue;
    const lat = gpsTextToDecimal(latMatch[1]);
    const lng = gpsTextToDecimal(lngMatch[1]);
    if (isValidLatLng(lat, lng)) return { latitude: Number(lat.toFixed(7)), longitude: Number(lng.toFixed(7)), has_exif_gps: true, exif_source: 'xmp_gps' };
  }
  return null;
}

function gpsTextToDecimal(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const decimal = raw.match(/^([+-]?\d+(?:\.\d+)?)([NSEW])?$/i);
  if (decimal) {
    let n = Number(decimal[1]);
    const ref = String(decimal[2] || '').toUpperCase();
    if (['S', 'W'].includes(ref) && n > 0) n *= -1;
    return Number.isFinite(n) ? n : null;
  }
  const parts = raw.match(/(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,\s]+(\d+(?:\.\d+)?))?\s*([NSEW])?/i);
  if (!parts) return null;
  let n = Number(parts[1]) + Number(parts[2] || 0) / 60 + Number(parts[3] || 0) / 3600;
  const ref = String(parts[4] || '').toUpperCase();
  if (['S', 'W'].includes(ref) && n > 0) n *= -1;
  return Number.isFinite(n) ? n : null;
}

export async function extractPhotoExifMetadata(file) {
  const result = { exif_status: 'unsupported', exif_source: null };
  if (!file) return result;
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  const looksJpeg = /^image\/jpe?g$/i.test(type) || /\.jpe?g$/i.test(name);
  if (!looksJpeg) {
    result.exif_status = type.includes('heic') || name.endsWith('.heic') || name.endsWith('.heif') ? 'unsupported_heic' : 'unsupported_type';
    result.exif_error = 'รองรับการอ่าน GPS จากไฟล์ JPEG/JPG เป็นหลัก';
    return result;
  }
  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) {
      result.exif_status = 'not_jpeg_binary';
      return result;
    }
    let offset = 2;
    while (offset + 4 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) { offset += 1; continue; }
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset + 2, false);
      if (!length || offset + 2 + length > view.byteLength) break;
      const segmentStart = offset + 4;
      const segmentLength = Math.max(0, length - 2);
      if (marker === 0xe1 && readAscii(view, segmentStart, 4) === 'Exif') {
        const tiffStart = segmentStart + 6;
        const endian = readAscii(view, tiffStart, 2);
        const littleEndian = endian === 'II';
        if (!littleEndian && endian !== 'MM') { result.exif_status = 'bad_tiff_endian'; return result; }
        if (readUInt16(view, tiffStart + 2, littleEndian) !== 42) { result.exif_status = 'bad_tiff_magic'; return result; }
        const firstIfdOffset = readUInt32(view, tiffStart + 4, littleEndian);
        const ifd0 = readIfdEntries(view, tiffStart, firstIfdOffset, littleEndian);
        const gpsIfdPointer = ifd0.get(0x8825);
        const exifIfdPointer = ifd0.get(0x8769);
        if (exifIfdPointer) {
          const exifIfd = readIfdEntries(view, tiffStart, Number(exifIfdPointer), littleEndian);
          const takenAt = parseExifDate(exifIfd.get(0x9003) || exifIfd.get(0x9004));
          if (takenAt) result.exif_taken_at = takenAt;
        }
        if (gpsIfdPointer) {
          const gps = readIfdEntries(view, tiffStart, Number(gpsIfdPointer), littleEndian);
          const lat = gpsDmsToDecimal(gps.get(0x0002), gps.get(0x0001));
          const lng = gpsDmsToDecimal(gps.get(0x0004), gps.get(0x0003));
          if (isValidLatLng(lat, lng)) {
            result.latitude = Number(lat.toFixed(7));
            result.longitude = Number(lng.toFixed(7));
            result.has_exif_gps = true;
            result.exif_status = 'gps_found';
            result.exif_source = 'jpeg_exif_gps';
            return result;
          }
          result.exif_status = 'gps_ifd_no_valid_latlng';
        } else {
          result.exif_status = 'exif_without_gps';
        }
      }
      if (marker === 0xe1 || marker === 0xed) {
        const sampleLength = Math.min(segmentLength, 160000);
        const text = readAscii(view, segmentStart, sampleLength);
        const xmpGps = parseXmpGpsDecimal(text);
        if (xmpGps) return { ...result, ...xmpGps, exif_status: 'gps_found' };
      }
      offset += 2 + length;
    }
    if (result.exif_status === 'unsupported') result.exif_status = 'no_exif_gps';
  } catch (error) {
    result.exif_status = 'read_error';
    result.exif_error = error?.message || String(error || 'อ่าน EXIF ไม่สำเร็จ');
  }
  return result;
}

export async function compressImageFile(file) {
  const startedAt = performance?.now?.() || Date.now();
  const exif = await extractPhotoExifMetadata(file);
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const originalWidth = image.naturalWidth || image.width || 0;
  const originalHeight = image.naturalHeight || image.height || 0;
  const main = await resizeToBlob(image, MAX_IMAGE_SIDE, IMAGE_QUALITY);
  const thumb = await resizeToBlob(image, THUMB_SIZE, THUMB_QUALITY);
  const blob = main.blob || file;
  const thumbBlob = thumb.blob || main.blob || file;
  const processedAt = performance?.now?.() || Date.now();
  return {
    blob,
    thumbBlob,
    width: main.width,
    height: main.height,
    thumbWidth: thumb.width,
    thumbHeight: thumb.height,
    original_width: originalWidth,
    original_height: originalHeight,
    original_size_bytes: file.size || blob.size || 0,
    compression_ratio: compressionRatio(file.size, blob.size),
    processing_ms: Math.max(0, Math.round(processedAt - startedAt)),
    mime_type: 'image/jpeg',
    original_type: file.type || 'image/jpeg',
    original_name: file.name || 'photo.jpg',
    size_bytes: blob.size,
    taken_at: exif.exif_taken_at || safeDateFromFile(file),
    exif_taken_at: exif.exif_taken_at || null,
    latitude: exif.latitude ?? null,
    longitude: exif.longitude ?? null,
    exif_latitude: exif.latitude ?? null,
    exif_longitude: exif.longitude ?? null,
    has_exif_gps: Boolean(exif.has_exif_gps),
    location_source: exif.has_exif_gps ? (exif.exif_source || 'exif_gps') : null,
    metadata: {
      exif_status: exif.exif_status || null,
      exif_source: exif.exif_source || null,
      exif_error: exif.exif_error || null,
      gps: exif.has_exif_gps ? { latitude: exif.latitude, longitude: exif.longitude, source: exif.exif_source || 'exif_gps' } : null
    },
    created_at: nowIso()
  };
}

export async function normalizePhotoImport(photo, memoId, tripId) {
  const data = photo?.data || photo?.dataUrl || photo?.url;
  if (!data) return null;
  const blob = await dataUrlToBlob(data);
  const file = new File([blob], photo.name || 'photo.jpg', { type: photo.type || blob.type || 'image/jpeg' });
  const compressed = await compressImageFile(file);
  return {
    ...compressed,
    id: uid(),
    memo_id: memoId,
    trip_id: tripId || null,
    sync_status: 'pending',
    storage_path: null,
    thumbnail_path: null,
    deleted_at: null,
    updated_at: nowIso()
  };
}

export function createObjectUrl(blob) {
  if (!blob) return '';
  try {
    return URL.createObjectURL(blob);
  } catch (error) {
    return '';
  }
}

export function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function dateParts(value) {
  const raw = String(value || '').trim();
  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return [Number(direct[1]), Number(direct[2]) - 1, Number(direct[3])];
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return [date.getFullYear(), date.getMonth(), date.getDate()];
}

export function dayDiff(start, end) {
  const a = dateParts(start);
  const b = dateParts(end);
  if (!a || !b) return 0;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((Date.UTC(b[0], b[1], b[2]) - Date.UTC(a[0], a[1], a[2])) / dayMs));
}
