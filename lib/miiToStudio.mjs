/*

Obtained from:

https://github.com/ariankordi/mii-fusion-experiments/blob/ecbf5e719b32b5bbd334dbdb036f00b5071824a3/MiiToStudio/MiiToStudio.fu

*/

// Generated automatically with "fut". Do not edit.

/**
 * Single-purpose class for converting Nintendo Mii formats to "Mii Studio data",
 * usable with the mii-unsecure.ariankordi.net rendering API to get a Mii image.
 */
export class MiiToStudio {

    /**
     * Size of Wii format Mii data (RFLCharData).
   * @public
   * @readonly
   * @type {number}
   */
    static SIZE_WII_DATA = 74;

    /**
     * Base size of 3DS/Wii U format Mii data.
     * Usually 96 bytes long (FFLStoreData, Ver3StoreData).
   * @public
   * @readonly
   * @type {number}
   */
    static SIZE3DS_WIIU_DATA = 72;

    /**
     * Size of Switch "nn::mii::CharInfo" format.
   * @public
   * @readonly
   * @type {number}
   */
    static SIZE_NX_CHAR_INFO = 88;

    /**
     * Base URL of /miis/image.png API that returns a Mii image.
     * This can also be replaced by mii-unsecure.ariankordi.net.
   * @public
   * @readonly
   * @type {string}
   */
    static URL_BASE_IMAGE_PNG = "https://mii-unsecure.ariankordi.net/miis/image.png?data=";

    /**
   * @readonly
   * @type {number}
   */
    static _SIZE_STUDIO_RAW_DATA = 46;

    /**
   * @readonly
   * @type {number}
   */
    static _SIZE_STUDIO_URL_DATA = 47;
    /**
     * Internal buffer returned by conversion methods.
   * @readonly
   * @type {Uint8Array}
   */
    _buf = new Uint8Array(46);

    /**
   * @readonly
   * @type {number}
   */
    static _SIZE_NX_STORE_DATA = 68;

    /**
   * @readonly
   * @type {number}
   */
    static _SIZE_NX_CORE_DATA = 48;

    /**
     * Gets the Mii image URL using the Mii data converted in this instance.
   * @public
   * @param {number} width Size (square) of the image.
   * @param {boolean} allBody Whether or not to get an image of the whole body ("all_body")
   */
    getImageUrl(width, allBody) {
        switch (width) {
            case 96:
            case 270:
            case 512:
                break;
            default:
                if ((width != 128 || allBody) && "https://mii-unsecure.ariankordi.net/miis/image.png?data=".startsWith("https://studio.mii.nintendo.com/")) {
                    console.log(`MiiToStudio.GetImageUrl(): Unsupported width ${width}, resetting to 512.`);
                    width = 512;
                }
                break;
        }
        let dataHex = "";
        const urlData = new Uint8Array(47);
        MiiToStudio.obfuscateStudioUrl(urlData, this._buf);
        for (let i = 0; i < 47; i++)
            dataHex += `${urlData[i].toString(16).padStart(2, "0")}`;
        let url = `https://mii-unsecure.ariankordi.net/miis/image.png?data=${dataHex}&width=${width}&type=`;
        url += allBody ? "all_body" : "face";
        return url;
    }

    /**
     * Decodes the input Mii data, where the type is automatically detected.
     *
     * <p>Returns null if the format is not supported.
     * Formats (3DS/Wii U):
     * <ul>
     * <li>96 byte FFLStoreData/nn::mii::Ver3StoreData (has CRC)</li>
     * <li>92 byte FFLiMiiDataOfficial (in database, or kazuki-4ys ".3dsmii")</li>
     * <li>72 byte FFLiMiiDataCore (no creator name or CRC)
     * Formats (Wii):</li>
     * <li>76 byte RFLStoreData (has CRC)</li>
     * <li>74 byte RFLCharData (no CRC)
     * Formats (Switch, Studio):</li>
     * <li>88 byte nn::mii::CharInfo</li>
     * <li>47 byte obfuscated studio URL data</li>
     * <li>46 byte un-obfuscated raw "Studio Code"</li>
     * </ul>
   * @public
   * @param {number} dataSize Size of the input data used to detect the type.
   * @param {Uint8Array} data Input Mii data to be converted.
   */
    fromAnyMiiData(dataSize, data) {
        switch (dataSize) {
            case 96:
            case 92:
            case 72:
                return this.from3dsWiiuData(data);
            case 76:
            case 74:
                return this.fromWiiData(data);
            case 46:
                this._buf.set(data.subarray(0, 46));
                return this._buf;
            case 47:
                MiiToStudio._deobfuscateStudioUrl(this._buf, data);
                return this._buf;
            case 88:
                return this.fromNxCharInfo(data);
            case 68:
            case 48:
                return null;
            default:
                return null;
        }
    }

    /**
     * Verifies if the converted data in this instance is considered valid.
     * Derived from nn::mii::detail::CharInfoRaw::IsValid,
     * but does not return the specific reason.
   * @public
   */
    isValid() {
        return this._buf[0] < 100 && this._buf[1] < 6 && 128 > this._buf[2] && this._buf[3] < 7 && this._buf[4] < 100 && this._buf[5] < 8 && this._buf[6] < 8 && this._buf[7] < 60 && this._buf[8] < 13 && this._buf[9] < 19 && this._buf[10] < 7 && this._buf[11] < 100 && this._buf[12] < 12 && this._buf[13] < 9 && this._buf[14] < 24 && this._buf[15] < 13 && this._buf[16] - 3 < 16 && this._buf[17] < 10 && this._buf[18] < 12 && this._buf[19] < 12 && this._buf[20] < 12 && this._buf[21] < 12 && this._buf[22] < 2 && this._buf[23] < 100 && this._buf[24] < 8 && this._buf[25] < 20 && this._buf[26] < 21 && this._buf[27] < 100 && this._buf[28] < 2 && this._buf[29] < 132 && 128 > this._buf[30] && this._buf[31] < 9 && this._buf[32] < 2 && this._buf[33] < 17 && this._buf[34] < 31 && this._buf[35] < 7 && this._buf[36] < 100 && this._buf[37] < 9 && this._buf[38] < 36 && this._buf[39] < 19 && this._buf[40] < 9 && this._buf[41] < 6 && this._buf[42] < 17 && this._buf[43] < 9 && this._buf[44] < 18 && this._buf[45] < 19;
    }

    /**
     * Decodes the input 3DS/Wii U Mii data (FFLStoreData/nn::mii::Ver3StoreData).
   * @public
   * @param {Uint8Array} data
   */
    from3dsWiiuData(data) {
        this._buf[0] = data[66] >> 3 & 7;
        this._buf[1] = data[66] & 7;
        this._buf[2] = data[47];
        this._buf[3] = data[53] >> 5;
        this._buf[4] = (data[53] & 1) << 2 | data[52] >> 6;
        this._buf[5] = data[54] & 31;
        this._buf[6] = data[53] >> 1 & 15;
        this._buf[7] = data[52] & 63;
        this._buf[8] = (data[55] & 1) << 3 | data[54] >> 5;
        this._buf[9] = data[55] >> 1 & 31;
        this._buf[10] = data[57] >> 4 & 7;
        this._buf[11] = data[56] >> 5;
        this._buf[12] = data[58] & 31;
        this._buf[13] = data[57] & 15;
        this._buf[14] = data[56] & 31;
        this._buf[15] = (data[59] & 1) << 3 | data[58] >> 5;
        this._buf[16] = data[59] >> 1 & 31;
        this._buf[17] = data[48] >> 5;
        this._buf[18] = data[49] >> 4;
        this._buf[19] = data[48] >> 1 & 15;
        this._buf[20] = data[49] & 15;
        this._buf[21] = data[25] >> 2 & 15;
        this._buf[22] = data[24] & 1;
        this._buf[23] = data[68] >> 4 & 7;
        this._buf[24] = (data[69] & 7) * 2 | data[68] >> 7;
        this._buf[25] = data[68] & 15;
        this._buf[26] = data[69] >> 3;
        this._buf[27] = data[51] & 7;
        this._buf[28] = data[51] >> 3 & 1;
        this._buf[29] = data[50];
        this._buf[30] = data[46];
        this._buf[31] = data[70] >> 1 & 15;
        this._buf[32] = data[70] & 1;
        this._buf[33] = (data[71] & 3) << 3 | data[70] >> 5;
        this._buf[34] = data[71] >> 2 & 31;
        this._buf[35] = data[63] >> 5;
        this._buf[36] = (data[63] & 1) << 2 | data[62] >> 6;
        this._buf[37] = data[63] >> 1 & 15;
        this._buf[38] = data[62] & 63;
        this._buf[39] = data[64] & 31;
        this._buf[40] = (data[67] & 3) << 2 | data[66] >> 6;
        this._buf[41] = data[64] >> 5;
        this._buf[42] = data[67] >> 2 & 31;
        this._buf[43] = (data[61] & 1) << 3 | data[60] >> 5;
        this._buf[44] = data[60] & 31;
        this._buf[45] = data[61] >> 1 & 31;
        MiiToStudio._convertFieldsVer3ToNx(this._buf);
        return this._buf;
    }

    /**
     * Decodes the input Wii Mii data (RFLCharData, RFLStoreData).
   * @public
   * @param {Uint8Array} data
   */
    fromWiiData(data) {
        this._buf[0] = data[50] >> 1 & 7;
        this._buf[1] = data[50] >> 4 & 3;
        this._buf[2] = data[23];
        this._buf[3] = 3;
        this._buf[4] = data[42] >> 5;
        this._buf[5] = data[41] >> 5 | (data[40] & 3) << 3;
        this._buf[6] = data[42] >> 1 & 15;
        this._buf[7] = data[40] >> 2;
        this._buf[8] = data[43] >> 5 | (data[42] & 1) << 3;
        this._buf[9] = data[41] & 31;
        this._buf[10] = 3;
        this._buf[11] = data[38] >> 5;
        this._buf[12] = data[37] >> 6 | (data[36] & 7) << 2;
        this._buf[13] = data[38] >> 1 & 15;
        this._buf[14] = data[36] >> 3;
        this._buf[15] = data[39] & 15;
        this._buf[16] = data[39] >> 4 | (data[38] & 1) << 4;
        this._buf[17] = data[32] >> 2 & 7;
        let faceTex = data[33] >> 6 | (data[32] & 3) << 2;
        this._buf[18] = MiiToStudio._FROM_WII_DATA_FACE_TEX_TABLE[faceTex * 2 + 1];
        this._buf[19] = data[32] >> 5;
        this._buf[20] = MiiToStudio._FROM_WII_DATA_FACE_TEX_TABLE[faceTex * 2];
        this._buf[21] = data[1] >> 1 & 15;
        this._buf[22] = data[0] >> 6 & 1;
        this._buf[23] = data[48] >> 1 & 7;
        this._buf[24] = data[49] >> 5 | (data[48] & 1) << 3;
        this._buf[25] = data[48] >> 4;
        this._buf[26] = data[49] & 31;
        this._buf[27] = data[35] >> 6 | (data[34] & 1) << 2;
        this._buf[28] = data[35] >> 5 & 1;
        this._buf[29] = data[34] >> 1;
        this._buf[30] = data[22];
        this._buf[31] = data[52] >> 3 & 15;
        this._buf[32] = data[52] >> 7;
        this._buf[33] = data[53] >> 1 & 31;
        this._buf[34] = data[53] >> 6 | (data[52] & 7) << 2;
        this._buf[35] = 3;
        this._buf[36] = data[46] >> 1 & 3;
        this._buf[37] = data[47] >> 5 | (data[46] & 1) << 3;
        this._buf[38] = data[46] >> 3;
        this._buf[39] = data[47] & 31;
        this._buf[40] = data[51] >> 5 | (data[50] & 1) << 3;
        this._buf[41] = data[50] >> 6;
        this._buf[42] = data[51] & 31;
        this._buf[43] = data[44] & 15;
        this._buf[44] = data[44] >> 4;
        this._buf[45] = data[45] >> 3;
        MiiToStudio._convertFieldsVer3ToNx(this._buf);
        return this._buf;
    }

    /**
     * Decodes the input Switch nn::mii::CharInfo format.
   * @public
   * @param {Uint8Array} data
   */
    fromNxCharInfo(data) {
        this._buf[0] = data[74];
        this._buf[1] = data[75];
        this._buf[2] = data[42];
        this._buf[3] = data[55];
        this._buf[4] = data[53];
        this._buf[5] = data[56];
        this._buf[6] = data[54];
        this._buf[7] = data[52];
        this._buf[8] = data[57];
        this._buf[9] = data[58];
        this._buf[10] = data[62];
        this._buf[11] = data[60];
        this._buf[12] = data[63];
        this._buf[13] = data[61];
        this._buf[14] = data[59];
        this._buf[15] = data[64];
        this._buf[16] = data[65];
        this._buf[17] = data[46];
        this._buf[18] = data[48];
        this._buf[19] = data[45];
        this._buf[20] = data[47];
        this._buf[21] = data[39];
        this._buf[22] = data[40];
        this._buf[23] = data[80];
        this._buf[24] = data[81];
        this._buf[25] = data[79];
        this._buf[26] = data[82];
        this._buf[27] = data[50];
        this._buf[28] = data[51];
        this._buf[29] = data[49];
        this._buf[30] = data[41];
        this._buf[31] = data[84];
        this._buf[32] = data[83];
        this._buf[33] = data[85];
        this._buf[34] = data[86];
        this._buf[35] = data[72];
        this._buf[36] = data[70];
        this._buf[37] = data[71];
        this._buf[38] = data[69];
        this._buf[39] = data[73];
        this._buf[40] = data[77];
        this._buf[41] = data[76];
        this._buf[42] = data[78];
        this._buf[43] = data[67];
        this._buf[44] = data[66];
        this._buf[45] = data[68];
        return this._buf;
    }

    /**
     * Common method to convert colors and other fields from
     * 3DS/Wii U and Wii data to Switch/Studio equivalents.
   * @param {Uint8Array} buf
   */
    static _convertFieldsVer3ToNx(buf) {
        if (buf[27] == 0)
            buf[27] = 8;
        if (buf[0] == 0)
            buf[0] = 8;
        if (buf[11] == 0)
            buf[11] = 8;
        buf[36] += 19;
        buf[4] += 8;
        if (buf[23] == 0)
            buf[23] = 8;
        else if (buf[23] < 6)
            buf[23] += 13;
        if (127 < buf[2])
            buf[2] = 127;
        if (127 < buf[30])
            buf[30] = 127;
    }

    /**
     * Obfuscates Studio data to be used in the URL.
   * @public
   * @param {Uint8Array} dst
   * @param {Uint8Array} src
   * @param {number} [seed=0] The random value to use for the obfuscation. Best left as 0.
   */
    static obfuscateStudioUrl(dst, src, seed = 0) {
        dst[0] = seed;
        for (let i = 0; i < 46; i++) {
            let val = src[i] ^ dst[i];
            dst[i + 1] = (7 + val) % 256;
        }
    }

    /**
     * Deobfuscates Studio URL data to raw decodable data.
   * @param {Uint8Array} dst
   * @param {Uint8Array} src
   */
    static _deobfuscateStudioUrl(dst, src) {
        for (let i = 0; i < 46; i++) {
            let val = (src[i + 1] - 7) % 256;
            dst[i] = val ^ src[i];
        }
    }

    /**
   * @readonly
   * @type {Uint8Array}
   */
    static _FROM_WII_DATA_FACE_TEX_TABLE = new Uint8Array([0, 0, 0, 1, 0, 6, 0, 9, 5, 0, 2, 0, 3, 0, 7, 0,
        8, 0, 0, 10, 9, 0, 11, 0]);
}
