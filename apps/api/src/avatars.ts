/** Where a person's picture is served from, versioned so it can be cached for good; null shows their initials. */
export function avatarUrl(userId: string, avatarAt: Date | null | undefined): string | null {
  return avatarAt ? `/api/v1/avatars/${userId}?v=${avatarAt.getTime().toString(36)}` : null;
}

/** JPEG, PNG or WebP, by their first bytes rather than what the upload claims (no SVG: it can carry script). */
export function imageType(data: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (
    data.length > 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (data.length > 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return null;
}
