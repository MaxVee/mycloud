"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const _ = require("lodash");
const Embed = require("@tradle/embed");
const engine_1 = require("@tradle/engine");
const types = require("./typeforce-types");
const errors_1 = require("./errors");
const constants_1 = require("./constants");
const utils_1 = require("./utils");
const crypto_1 = require("./crypto");
class Objects {
    constructor(tradle) {
        this.validate = (object) => {
            try {
                crypto_1.extractSigPubKey(object);
            }
            catch (err) {
                throw new errors_1.InvalidSignature(`for ${object[constants_1.TYPE]}`);
            }
        };
        this.addMetadata = (object) => {
            utils_1.typeforce(types.signedObject, object);
            const type = object[constants_1.TYPE];
            if (object._sigPubKey) {
                debugger;
                this.logger.warn('object has "_sigPubKey", be sure you validated it!', {
                    object,
                    stack: new Error().stack
                });
            }
            else {
                let pubKey;
                try {
                    pubKey = crypto_1.extractSigPubKey(object);
                }
                catch (err) {
                    this.logger.error('invalid object', {
                        object,
                        error: err.stack
                    });
                    throw new errors_1.InvalidSignature(`for ${type}`);
                }
                utils_1.setVirtual(object, { _sigPubKey: pubKey.pub });
            }
            crypto_1.addLinks(object);
            return object;
        };
        this.replaceEmbeds = (object) => __awaiter(this, void 0, void 0, function* () {
            const replacements = Embed.replaceDataUrls({
                region: this.region,
                bucket: this.fileUploadBucketName,
                keyPrefix: '',
                object
            });
            if (replacements.length) {
                this.logger.debug(`replaced ${replacements.length} embedded media`);
                yield Promise.all(replacements.map(replacement => {
                    const { bucket, key, body, mimetype } = replacement;
                    return this.s3Utils.put({
                        bucket,
                        key,
                        value: body,
                        headers: {
                            ContentType: mimetype
                        }
                    });
                }));
            }
        });
        this.resolveEmbed = (embed) => {
            this.logger.debug(`resolving embedded media: ${embed.url}`);
            const { presigned, key, bucket } = embed;
            return embed.presigned
                ? utils_1.download(embed)
                : this.s3Utils.get({ key, bucket }).then(({ Body, ContentType }) => {
                    Body.mimetype = ContentType;
                    return Body;
                });
        };
        this.resolveEmbeds = (object) => {
            return Embed.resolveEmbeds({ object, resolve: this.resolveEmbed });
        };
        this.get = (link) => __awaiter(this, void 0, void 0, function* () {
            utils_1.typeforce(utils_1.typeforce.String, link);
            this.logger.debug('getting', link);
            return yield this.bucket.getJSON(link);
        });
        this.put = (object) => __awaiter(this, void 0, void 0, function* () {
            utils_1.typeforce(types.signedObject, object);
            utils_1.ensureTimestamped(object);
            this.addMetadata(object);
            object = _.cloneDeep(object);
            yield this.replaceEmbeds(object);
            this.logger.debug('putting', utils_1.summarizeObject(object));
            return yield this.bucket.putJSON(object._link, object);
        });
        this.prefetch = (link) => {
            this.get(link);
        };
        this.del = (link) => __awaiter(this, void 0, void 0, function* () {
            yield this.bucket.del(link);
        });
        this.presignEmbeddedMediaLinks = (opts) => {
            const { object, stripEmbedPrefix } = opts;
            Embed.presignUrls({
                object,
                sign: ({ bucket, key, path }) => {
                    this.logger.debug('pre-signing url for', {
                        type: object[constants_1.TYPE],
                        property: path
                    });
                    return this.s3Utils.createPresignedUrl({ bucket, key });
                }
            });
            if (stripEmbedPrefix) {
                Embed.stripEmbedPrefix(object);
            }
            return object;
        };
        this.validateNewVersion = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { identities } = this.tradle;
            const { object } = opts;
            const previous = yield this.get(object[constants_1.PREVLINK]);
            yield Promise.all([
                object._author ? utils_1.RESOLVED_PROMISE : identities.addAuthorInfo(object),
                previous._author ? utils_1.RESOLVED_PROMISE : identities.addAuthorInfo(previous)
            ]);
            if (object._author !== previous._author) {
                throw new errors_1.InvalidAuthor(`expected ${previous._author}, got ${object._author}`);
            }
            try {
                engine_1.protocol.validateVersioning({
                    object,
                    prev: previous,
                    orig: object[constants_1.PERMALINK]
                });
            }
            catch (err) {
                throw new errors_1.InvalidVersion(err.message);
            }
        });
        const { env, buckets, s3Utils, logger } = tradle;
        this.tradle = tradle;
        this.env = env;
        this.region = env.REGION;
        this.buckets = buckets;
        this.bucket = this.buckets.Objects;
        this.s3Utils = s3Utils;
        this.fileUploadBucketName = buckets.FileUpload.name;
        this.logger = logger.sub('objects');
    }
}
exports.default = Objects;
exports.Objects = Objects;
//# sourceMappingURL=objects.js.map