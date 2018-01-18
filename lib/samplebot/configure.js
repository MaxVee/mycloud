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
const Promise = require("bluebird");
const _ = require("lodash");
const constants_1 = require("@tradle/constants");
const validateResource = require("@tradle/validate-resource");
const buildResource = require("@tradle/build-resource");
const serverlessYml = require("../cli/serverless-yml");
const Errors = require("../errors");
const utils_1 = require("../utils");
const cacheable_bucket_item_1 = require("../cacheable-bucket-item");
const model_store_1 = require("../model-store");
const { LOGO_UNKNOWN } = require('./media');
const DEFAULT_CONF = require('./conf/provider');
const { reinitializeOnConfChanged } = serverlessYml.custom;
const parseJSON = JSON.parse.bind(JSON);
const getHandleFromName = (name) => {
    return name.replace(/[^A-Za-z]/g, '').toLowerCase();
};
const baseOrgObj = {
    [constants_1.TYPE]: 'tradle.Organization'
};
const baseStylePackObj = {
    [constants_1.TYPE]: 'tradle.StylesPack'
};
exports.BOT_CONF_KEY = 'conf/bot.json';
exports.MODELS_PACK_KEY = 'conf/models-pack.json';
exports.LENSES_KEY = 'conf/lenses.json';
exports.STYLE_KEY = 'conf/style.json';
exports.ORG_KEY = 'org/org.json';
exports.INFO_KEY = 'info/info.json';
exports.TERMS_AND_CONDITIONS_KEY = 'conf/terms-and-conditions.md';
const MINUTE = 3600000;
const HALF_HOUR = MINUTE * 30;
const HOUR = HALF_HOUR * 2;
const DEFAULT_TTL = HALF_HOUR;
const parts = {
    org: {
        bucket: 'PrivateConf',
        key: exports.ORG_KEY,
        ttl: DEFAULT_TTL
    },
    style: {
        bucket: 'PrivateConf',
        key: exports.STYLE_KEY,
        ttl: DEFAULT_TTL
    },
    info: {
        bucket: 'PrivateConf',
        key: exports.INFO_KEY,
        ttl: DEFAULT_TTL
    },
    botConf: {
        bucket: 'PrivateConf',
        key: exports.BOT_CONF_KEY,
        ttl: DEFAULT_TTL
    },
    modelsPack: {
        bucket: 'PrivateConf',
        key: exports.MODELS_PACK_KEY,
        ttl: DEFAULT_TTL
    },
    lenses: {
        bucket: 'PrivateConf',
        key: exports.LENSES_KEY,
        ttl: DEFAULT_TTL
    },
    termsAndConditions: {
        bucket: 'PrivateConf',
        key: exports.TERMS_AND_CONDITIONS_KEY,
        ttl: DEFAULT_TTL,
        parse: value => value.toString()
    }
};
class Conf {
    constructor({ bot, logger }) {
        this.get = () => __awaiter(this, void 0, void 0, function* () {
            const promises = {};
            Object.keys(parts).forEach(key => {
                promises[key] = this[key].get().catch(err => null);
            });
            return yield Promise.props(promises);
        });
        this.setBotConf = (value) => __awaiter(this, void 0, void 0, function* () {
            return yield this.botConf.putIfDifferent(value);
        });
        this.setStyle = (value) => __awaiter(this, void 0, void 0, function* () {
            validateResource({
                models: this.bot.models,
                model: 'tradle.StylesPack',
                resource: value
            });
            yield this.style.putIfDifferent(value);
        });
        this.setCustomModels = (modelsPack) => __awaiter(this, void 0, void 0, function* () {
            const { domain } = yield this.org.get();
            const namespace = model_store_1.toggleDomainVsNamespace(domain);
            if (namespace !== modelsPack.namespace) {
                throw new Error(`expected namespace "${namespace}"`);
            }
            yield this.modelStore.saveCustomModels(modelsPack);
            yield this.modelsPack.putIfDifferent(modelsPack);
        });
        this.setTermsAndConditions = (value) => __awaiter(this, void 0, void 0, function* () {
            return yield this.termsAndConditions.putIfDifferent(value);
        });
        this.forceReinitializeContainers = () => __awaiter(this, void 0, void 0, function* () {
            return yield this.bot.forceReinitializeContainers(reinitializeOnConfChanged);
        });
        this.getPublicInfo = () => __awaiter(this, void 0, void 0, function* () {
            return yield this.calcPublicInfo();
        });
        this.calcPublicInfo = () => __awaiter(this, void 0, void 0, function* () {
            const [org, style, identity, conf] = yield Promise.all([
                this.org.get(),
                this.style.get(),
                this.bot.getMyIdentity(),
                this.botConf.get()
            ]);
            return this.assemblePublicInfo({ identity, org, style, conf });
        });
        this.recalcPublicInfo = () => __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getPublicInfo();
            yield this.info.putIfDifferent(info);
            return info;
        });
        this.assemblePublicInfo = ({ identity, org, style, conf }) => {
            const tour = _.get(conf, 'tours.intro');
            return {
                bot: {
                    profile: {
                        name: {
                            firstName: `${org.name} Bot`
                        }
                    },
                    pub: buildResource.omitVirtual(identity)
                },
                id: getHandleFromName(org.name),
                org: buildResource.omitVirtual(org),
                style,
                tour,
            };
        };
        this.init = (conf, opts = {}) => __awaiter(this, void 0, void 0, function* () {
            conf = Object.assign({}, DEFAULT_CONF, conf);
            const { bot } = this;
            if (bot.isTesting) {
                const { org } = conf;
                org.name += '-local';
            }
            const orgTemplate = conf.org;
            this.logger.info(`initializing provider ${orgTemplate.name}`);
            let identity;
            try {
                const identityInfo = yield bot.init({
                    force: opts.forceRecreateIdentity
                });
                identity = identityInfo.pub;
            }
            catch (err) {
                Errors.ignore(err, Errors.Exists);
                identity = yield bot.getMyIdentity();
            }
            const existing = yield this.get();
            if (existing.org)
                return;
            const logo = yield this.getLogo(conf);
            if (!orgTemplate.logo) {
                orgTemplate.logo = logo;
            }
            let { style } = conf;
            if (!style) {
                style = conf.style = Object.assign({}, baseStylePackObj);
            }
            if (!style.logo) {
                style.logo = {
                    url: logo
                };
            }
            const org = yield bot.signAndSave(buildOrg(orgTemplate));
            yield this.save({ identity, org, bot: conf.bot, style });
        });
        this.update = (update) => __awaiter(this, void 0, void 0, function* () {
            const { style, modelsPack, bot, terms } = update;
            if (style) {
                yield this.setStyle(style);
                yield this.recalcPublicInfo();
            }
            if (modelsPack) {
                yield this.setCustomModels(modelsPack);
            }
            if (bot) {
                yield this.setBotConf(bot);
                yield this.recalcPublicInfo();
            }
            if (terms) {
                yield this.setTermsAndConditions(terms);
            }
        });
        this.save = ({ identity, org, style, bot }) => __awaiter(this, void 0, void 0, function* () {
            yield Promise.all([
                style ? this.style.put(style) : utils_1.RESOLVED_PROMISE,
                org ? this.org.put(org) : utils_1.RESOLVED_PROMISE,
                bot ? this.botConf.put(bot) : utils_1.RESOLVED_PROMISE,
            ]);
        });
        this.getLogo = (conf) => __awaiter(this, void 0, void 0, function* () {
            const defaultLogo = _.get(conf, 'style.logo.url');
            let { name, domain, logo = defaultLogo } = conf.org;
            if (!(name && domain)) {
                throw new Error('org "name" and "domain" are required');
            }
            if (!(logo && /^data:/.test(logo))) {
                const ImageUtils = require('./image-utils');
                try {
                    return yield ImageUtils.getLogo({ logo, domain });
                }
                catch (err) {
                    this.logger.debug(`unable to load logo for domain: ${domain}`);
                    return LOGO_UNKNOWN;
                }
            }
            return logo;
        });
        this.bot = bot;
        this.modelStore = bot.modelStore;
        this.logger = logger || bot.logger;
        const { buckets } = bot;
        this.privateConfBucket = buckets.PrivateConf;
        for (let name in parts) {
            let part = parts[name];
            this[name] = new cacheable_bucket_item_1.CacheableBucketItem({
                bucket: buckets[part.bucket],
                key: part.key,
                ttl: part.ttl,
                parse: part.parse || parseJSON
            });
        }
    }
}
exports.Conf = Conf;
exports.createConf = (opts) => new Conf(opts);
const hasDifferentValue = ({ bucket, key, value }) => __awaiter(this, void 0, void 0, function* () {
    try {
        const current = yield bucket.get(key);
        return !_.isEqual(current, value);
    }
    catch (err) {
        Errors.ignore(err, Errors.NotFound);
        return true;
    }
});
const buildOrg = ({ name, domain, logo }) => (Object.assign({}, baseOrgObj, { name,
    domain, photos: [
        {
            url: logo
        }
    ] }));
const validateOrgUpdate = ({ current, update }) => {
    if (update.domain !== current.domain) {
        throw new Error('cannot change org "domain" at this time');
    }
    if (update.name !== current.name) {
        throw new Error('cannot change org "domain" at this time');
    }
    if (update.logo && update.logo !== current.logo) {
        throw new Error('cannot change org "logo" at this time');
    }
};
//# sourceMappingURL=configure.js.map