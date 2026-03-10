'use strict';

/**
 * Convert raw Mii binary data to Mii Studio format (46-byte deobfuscated).
 *
 * Supports:
 *  - 3DS / Wii U format (FFLStoreData / Ver3StoreData, 96 bytes)
 *
 * Based on the mii2studio Go implementation by ariankordi:
 * https://github.com/ariankordi/nwf-mii-cemu-toy/tree/master/mii2studio
 *
 * The 46-byte output matches the Gen3Studio kaitai struct (gen3_studio.go).
 * Passing this as a 92-character hex string to Arian's mii-unsecure API at
 *   /miis/image.png?data=<hex>&width=<w>&type=face
 * yields a rendered Mii image without requiring Nintendo's obfuscation step.
 */

/**
 * Convert a 3DS/Wii U Mii binary buffer (96 bytes, FFLStoreData/Ver3StoreData)
 * to the 46-byte Mii Studio format.
 *
 * Field layout (Gen3Studio, one byte per field):
 *  0  FacialHairColor   1  BeardGoatee       2  BodyWeight
 *  3  EyeStretch        4  EyeColor          5  EyeRotation
 *  6  EyeSize           7  EyeType           8  EyeHorizontal
 *  9  EyeVertical      10  EyebrowStretch   11  EyebrowColor
 * 12  EyebrowRotation  13  EyebrowSize      14  EyebrowType
 * 15  EyebrowHorizontal 16 EyebrowVertical  17  FaceColor
 * 18  FaceMakeup       19  FaceType         20  FaceWrinkles
 * 21  FavoriteColor    22  Gender           23  GlassesColor
 * 24  GlassesSize      25  GlassesType      26  GlassesVertical
 * 27  HairColor        28  HairFlip         29  HairType
 * 30  BodyHeight       31  MoleSize         32  MoleEnable
 * 33  MoleHorizontal   34  MoleVertical     35  MouthStretch
 * 36  MouthColor       37  MouthSize        38  MouthType
 * 39  MouthVertical    40  BeardSize        41  BeardMustache
 * 42  BeardVertical    43  NoseSize         44  NoseType
 * 45  NoseVertical
 *
 * @param {Buffer} data  96-byte Mii binary
 * @returns {Buffer|null}  46-byte studio buffer, or null on invalid input
 */
function convert3DSWiiU(data) {
  if (!Buffer.isBuffer(data) || data.length < 72) return null;

  // ── Fixed-width fields ────────────────────────────────────────────────────
  // Byte 46: BodyHeight
  // Byte 47: BodyWeight
  const BodyHeight = data[46];
  const BodyWeight = data[47];

  // Byte 24-25: Data1 (uint16 LE) – gender / favorite color / birthday
  const Data1 = data.readUInt16LE(24);
  const Gender        = Data1 & 0x1;
  const FavoriteColor = (Data1 >> 10) & 0xF;

  // ── Bit-packed: byte 48 ── FaceColor(3 MSBs), FaceType(4), Mingle(1 LSB) ─
  const b48       = data[48];
  const FaceColor    = (b48 >> 5) & 0x7;
  const FaceType     = (b48 >> 1) & 0xF;
  // Mingle bit ignored (not used in studio format)

  // Byte 49: FaceMakeup(4 MSBs), FaceWrinkles(4 LSBs)
  const b49          = data[49];
  const FaceMakeup   = (b49 >> 4) & 0xF;
  const FaceWrinkles = b49 & 0xF;

  // Byte 50: HairType
  const HairType = data[50];

  // Byte 51: Unknown5(4 MSBs), HairFlip(1), HairColor(3 LSBs)
  const b51      = data[51];
  const HairFlip = (b51 >> 3) & 0x1;
  const HairColor = b51 & 0x7;

  // ── Eye: uint32 LE at offset 52 ───────────────────────────────────────────
  const Eye          = data.readUInt32LE(52);
  const EyeType      = Eye & 0x3F;
  const EyeColor     = (Eye >> 6) & 0x7;
  const EyeSize      = (Eye >> 9) & 0x7;
  const EyeStretch   = (Eye >> 13) & 0x7;
  const EyeRotation  = (Eye >> 16) & 0x1F;
  const EyeHorizontal = (Eye >> 21) & 0xF;
  const EyeVertical  = (Eye >> 25) & 0x1F;

  // ── Eyebrow: uint32 LE at offset 56 ──────────────────────────────────────
  const Eyebrow           = data.readUInt32LE(56);
  const EyebrowType       = Eyebrow & 0x1F;
  const EyebrowColor      = (Eyebrow >> 5) & 0x7;
  const EyebrowSize       = (Eyebrow >> 8) & 0xF;
  const EyebrowStretch    = (Eyebrow >> 12) & 0x7;
  const EyebrowRotation   = (Eyebrow >> 16) & 0xF;
  const EyebrowHorizontal = (Eyebrow >> 21) & 0xF;
  const EyebrowVertical   = (Eyebrow >> 25) & 0x1F;

  // ── Nose: uint16 LE at offset 60 ─────────────────────────────────────────
  const Nose        = data.readUInt16LE(60);
  const NoseType    = Nose & 0x1F;
  const NoseSize    = (Nose >> 5) & 0xF;
  const NoseVertical = (Nose >> 9) & 0x1F;

  // ── Mouth: uint16 LE at offset 62 ────────────────────────────────────────
  const Mouth         = data.readUInt16LE(62);
  const MouthType     = Mouth & 0x3F;
  const MouthColor    = (Mouth >> 6) & 0x7;
  const MouthSize     = (Mouth >> 9) & 0xF;
  const MouthStretch  = (Mouth >> 13) & 0x7;

  // ── Mouth2: uint16 LE at offset 64 ───────────────────────────────────────
  const Mouth2             = data.readUInt16LE(64);
  const MouthVertical      = Mouth2 & 0x1F;
  const FacialHairMustache = (Mouth2 >> 5) & 0x7;

  // ── Beard: uint16 LE at offset 66 ────────────────────────────────────────
  const Beard              = data.readUInt16LE(66);
  const FacialHairBeard    = Beard & 0x7;
  const FacialHairColor    = (Beard >> 3) & 0x7;
  const FacialHairSize     = (Beard >> 6) & 0xF;
  const FacialHairVertical = (Beard >> 10) & 0x1F;

  // ── Glasses: uint16 LE at offset 68 ──────────────────────────────────────
  const Glasses        = data.readUInt16LE(68);
  const GlassesType    = Glasses & 0xF;
  const GlassesColorRaw = (Glasses >> 4) & 0x7;
  const GlassesSize    = (Glasses >> 7) & 0xF;
  const GlassesVertical = (Glasses >> 11) & 0x1F;

  // ── Mole: uint16 LE at offset 70 ─────────────────────────────────────────
  const Mole           = data.readUInt16LE(70);
  const MoleEnable     = Mole & 0x1;
  const MoleSize       = (Mole >> 1) & 0xF;
  const MoleHorizontal = (Mole >> 5) & 0x1F;
  const MoleVertical   = (Mole >> 10) & 0x1F;

  // ── Color conversions (Gen2 → Gen3 color index mapping) ──────────────────
  let finalFacialHairColor = FacialHairColor;
  if (finalFacialHairColor === 0) finalFacialHairColor = 8;

  const finalEyeColor = EyeColor + 8;

  let finalEyebrowColor = EyebrowColor;
  if (finalEyebrowColor === 0) finalEyebrowColor = 8;

  let finalGlassesColor = GlassesColorRaw;
  if (finalGlassesColor === 0) finalGlassesColor = 8;
  else if (finalGlassesColor < 6) finalGlassesColor = finalGlassesColor + 13;

  let finalHairColor = HairColor;
  if (finalHairColor === 0) finalHairColor = 8;

  const finalMouthColor = MouthColor + 19;

  // ── Build 46-byte output in Gen3Studio field order ────────────────────────
  return Buffer.from([
    finalFacialHairColor,   //  0 FacialHairColor
    FacialHairBeard,        //  1 BeardGoatee
    BodyWeight,             //  2 BodyWeight
    EyeStretch,             //  3 EyeStretch
    finalEyeColor,          //  4 EyeColor
    EyeRotation,            //  5 EyeRotation
    EyeSize,                //  6 EyeSize
    EyeType,                //  7 EyeType
    EyeHorizontal,          //  8 EyeHorizontal
    EyeVertical,            //  9 EyeVertical
    EyebrowStretch,         // 10 EyebrowStretch
    finalEyebrowColor,      // 11 EyebrowColor
    EyebrowRotation,        // 12 EyebrowRotation
    EyebrowSize,            // 13 EyebrowSize
    EyebrowType,            // 14 EyebrowType
    EyebrowHorizontal,      // 15 EyebrowHorizontal
    EyebrowVertical,        // 16 EyebrowVertical
    FaceColor,              // 17 FaceColor
    FaceMakeup,             // 18 FaceMakeup
    FaceType,               // 19 FaceType
    FaceWrinkles,           // 20 FaceWrinkles
    FavoriteColor,          // 21 FavoriteColor
    Gender,                 // 22 Gender
    finalGlassesColor,      // 23 GlassesColor
    GlassesSize,            // 24 GlassesSize
    GlassesType,            // 25 GlassesType
    GlassesVertical,        // 26 GlassesVertical
    finalHairColor,         // 27 HairColor
    HairFlip,               // 28 HairFlip
    HairType,               // 29 HairType
    BodyHeight,             // 30 BodyHeight
    MoleSize,               // 31 MoleSize
    MoleEnable,             // 32 MoleEnable
    MoleHorizontal,         // 33 MoleHorizontal
    MoleVertical,           // 34 MoleVertical
    MouthStretch,           // 35 MouthStretch
    finalMouthColor,        // 36 MouthColor
    MouthSize,              // 37 MouthSize
    MouthType,              // 38 MouthType
    MouthVertical,          // 39 MouthVertical
    FacialHairSize,         // 40 BeardSize
    FacialHairMustache,     // 41 BeardMustache
    FacialHairVertical,     // 42 BeardVertical
    NoseSize,               // 43 NoseSize
    NoseType,               // 44 NoseType
    NoseVertical            // 45 NoseVertical
  ]);
}

/**
 * Build an Arian mii-unsecure render URL from raw Mii binary data (base64).
 *
 * For 3DS/Wii U format (72–100 bytes): converts to 46-byte Mii Studio data
 * and calls /miis/image.png with the raw (deobfuscated) hex — no Nintendo
 * obfuscation required since ariankordi's site accepts the plain studio bytes.
 *
 * For all other sizes (Wii 74-byte, Switch 88-byte, etc.): falls back to the
 * /mii_renders endpoint which accepts raw binary data in base64.
 *
 * @param {string} miiDataBase64  base64-encoded raw Mii binary
 * @param {number} [width=1200]   render width in pixels
 * @returns {string}  render URL
 */
function getMiiRenderUrl(miiDataBase64, width = 1200) {
  let raw;
  try {
    raw = Buffer.from(miiDataBase64, 'base64');
  } catch {
    return `http://mii-unsecure.ariankordi.net/mii_renders?data=${encodeURIComponent(miiDataBase64)}&type=face&width=${width}&shaderType=0&mipmapOff=true`;
  }

  // 3DS / Wii U format is typically 96 bytes (FFLStoreData / Ver3StoreData).
  // Accept 90–100 to accommodate any minor size variation in the FFSD container
  // while still excluding Wii format (74 bytes) and Switch CharInfo (88 bytes),
  // both of which have different binary layouts and should use the fallback path.
  if (raw.length >= 90 && raw.length <= 100) {
    const studioBuf = convert3DSWiiU(raw);
    if (studioBuf && studioBuf.length === 46) {
      const hex = studioBuf.toString('hex');
      return `http://mii-unsecure.ariankordi.net/miis/image.png?data=${hex}&type=face&width=${width}`;
    }
  }

  // Fallback: pass raw binary as base64 to mii_renders
  return `http://mii-unsecure.ariankordi.net/mii_renders?data=${encodeURIComponent(miiDataBase64)}&type=face&width=${width}&shaderType=0&mipmapOff=true`;
}

module.exports = { convert3DSWiiU, getMiiRenderUrl };
