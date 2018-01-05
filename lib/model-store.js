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
const events_1 = require("events");
const _ = require("lodash");
const mergeModels = require("@tradle/merge-models");
const ModelsPack = require("@tradle/models-pack");
const constants_1 = require("@tradle/constants");
const dynamodb_1 = require("@tradle/dynamodb");
const cacheable_bucket_item_1 = require("./cacheable-bucket-item");
const Errors = require("./errors");
const constants_2 = require("./constants");
const utils_1 = require("./utils");
const CUMULATIVE_PACK_KEY = constants_2.PRIVATE_CONF_BUCKET.modelsPack;
const CUMULATIVE_GRAPHQL_SCHEMA_KEY = constants_2.PRIVATE_CONF_BUCKET.graphqlSchema;
const MODELS_PACK = 'tradle.ModelsPack';
const MODELS_PACK_CACHE_MAX_AGE = 60000;
const MODELS_FOLDER = 'models';
const BUILT_IN_NAMESPACES = [
    'tradle',
    'io.tradle'
];
const MINUTE = 60000;
const firstValue = obj => {
    for (let key in obj)
        return obj[key];
};
class ModelStore extends events_1.EventEmitter {
    constructor(tradle) {
        super();
        this.get = (id) => __awaiter(this, void 0, void 0, function* () {
            const namespace = ModelsPack.getNamespace(id);
            if (ModelsPack.isReservedNamespace(namespace)) {
                return this.cache.models[id];
            }
            return yield this.cache.get(id);
        });
        this.addModelsPack = ({ modelsPack, validateAuthor = true, validateUpdate = true }) => __awaiter(this, void 0, void 0, function* () {
            if (validateAuthor) {
                yield this.validateModelsPackNamespaceOwner(modelsPack);
            }
            if (validateUpdate) {
                yield this.validateModelsPackUpdate(modelsPack);
            }
            const current = yield this.getCumulativeModelsPack();
            let cumulative;
            if (current) {
                const { namespace } = modelsPack;
                const models = current.models
                    .filter(model => ModelsPack.getNamespace(model) !== namespace)
                    .concat(modelsPack.models);
                cumulative = ModelsPack.pack({ models });
            }
            else {
                cumulative = modelsPack;
            }
            yield Promise.all([
                this.bucket.gzipAndPut(this.cumulativePackKey, cumulative),
                this.updateGraphqlSchema({ cumulativeModelsPack: cumulative })
            ]);
            return cumulative;
        });
        this.updateGraphqlSchema = (opts = {}) => __awaiter(this, void 0, void 0, function* () {
            let { cumulativeModelsPack } = opts;
            if (!cumulativeModelsPack)
                cumulativeModelsPack = yield this.getCumulativeModelsPack();
            const models = getCumulative(this, cumulativeModelsPack, false);
            const { exportSchema } = require('./bot/graphql');
            const schema = exportSchema({ models });
            yield this.bucket.gzipAndPut(this.cumulativeGraphqlSchemaKey, schema);
        });
        this.loadModelsPacks = () => __awaiter(this, void 0, void 0, function* () {
            const cumulative = yield this.getCumulativeModelsPack();
            if (cumulative) {
                _.each(cumulative, ({ models }) => this.addModels(models));
            }
        });
        this.getCumulativeModelsPack = () => __awaiter(this, void 0, void 0, function* () {
            try {
                return yield this.bucket.getJSON(this.cumulativePackKey);
            }
            catch (err) {
                Errors.ignore(err, Errors.NotFound);
                return null;
            }
        });
        this.getSavedGraphqlSchema = () => __awaiter(this, void 0, void 0, function* () {
            const schema = yield this.bucket.getJSON(this.cumulativeGraphqlSchemaKey);
            return require('./bot/graphql').importSchema(schema);
        });
        this.getGraphqlSchema = () => __awaiter(this, void 0, void 0, function* () {
            try {
                return yield this.getSavedGraphqlSchema();
            }
            catch (err) {
                Errors.ignore(err, Errors.NotFound);
                return require('./bot/graphql').exportSchema({
                    models: this.models
                });
            }
        });
        this.getModelsForNamespace = (namespace) => {
            const prefix = namespace + '.';
            const models = _.filter(this.models, (value, key) => key.startsWith(prefix));
            return ModelsPack.pack({ namespace, models });
        };
        this.saveCustomModels = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { namespace, models } = opts;
            if (namespace) {
                this.setMyNamespace(namespace);
            }
            this.setCustomModels(opts);
            yield this.addModelsPack({
                validateAuthor: false,
                modelsPack: this.myModelsPack
            });
        });
        this.setCustomModels = ({ models, namespace }) => {
            const first = firstValue(models);
            if (!first)
                return;
            if (!namespace) {
                namespace = this.myNamespace || ModelsPack.getNamespace(first);
            }
            mergeModels()
                .add(this.baseModels, { validate: false })
                .add(models);
            const pack = ModelsPack.pack({ namespace, models });
            ModelsPack.validate(pack);
            this.cache.removeModels(this.myCustomModels);
            this.addModels(models);
            this.myModelsPack = pack;
            this.myNamespace = namespace;
            this.myCustomModels = _.clone(models);
        };
        this.setMyNamespace = (namespace) => {
            this.myNamespace = namespace;
            this.myDomain = exports.toggleDomainVsNamespace(namespace);
        };
        this.setMyDomain = (domain) => {
            this.myDomain = domain;
            this.myNamespace = exports.toggleDomainVsNamespace(domain);
        };
        this.addModels = (models) => {
            this.cache.addModels(models);
        };
        this.getModelsPackByDomain = (domain) => __awaiter(this, void 0, void 0, function* () {
            return yield this.bucket.getJSON(getModelsPackConfKey(domain));
        });
        this.validateModelsPackNamespaceOwner = (pack) => __awaiter(this, void 0, void 0, function* () {
            if (!pack.namespace) {
                throw new Error(`ignoring ModelsPack sent by ${pack._author}, as it isn't namespaced`);
            }
            const domain = ModelsPack.getDomain(pack);
            const friend = yield this.tradle.friends.getByDomain(domain);
            if (!pack._author) {
                yield this.tradle.identities.addAuthorInfo(pack);
            }
            if (friend._identityPermalink !== pack._author) {
                throw new Error(`ignoring ModelsPack sent by ${pack._author}.
Domain ${domain} (and namespace ${pack.namespace}) belongs to ${friend._identityPermalink}`);
            }
        });
        this.validateModelsPackUpdate = (pack) => __awaiter(this, void 0, void 0, function* () {
            const ret = {
                changed: true
            };
            const domain = ModelsPack.getDomain(pack);
            try {
                const current = yield this.getModelsPackByDomain(domain);
                exports.validateUpdate(current, pack);
                ret.changed = current.versionId !== pack.versionId;
            }
            catch (err) {
                Errors.ignore(err, Errors.NotFound);
            }
            return ret;
        });
        this.validateModelsPack = (modelsPack) => __awaiter(this, void 0, void 0, function* () {
            yield this.validateModelsPackNamespaceOwner(modelsPack);
            return yield this.validateModelsPackUpdate(modelsPack);
        });
        this.saveModelsPack = ({ modelsPack }) => __awaiter(this, void 0, void 0, function* () {
            const { changed } = yield this.validateModelsPack(modelsPack);
            if (!changed)
                return;
            yield this.bucket.gzipAndPut(getModelsPackConfKey(modelsPack), modelsPack);
        });
        this.onMissingModel = (id) => __awaiter(this, void 0, void 0, function* () {
            const modelsPack = yield this.getModelsPackByDomain(ModelsPack.getDomain(id));
            this.cache.addModels(modelsPack.models);
        });
        this.tradle = tradle;
        this.logger = tradle.logger.sub('modelstore');
        this.baseModels = tradle.models;
        this.baseModelsIds = Object.keys(this.baseModels);
        this.myCustomModels = {};
        this.cache = dynamodb_1.createModelStore({
            models: this.baseModels,
            onMissingModel: this.onMissingModel.bind(this)
        });
        this.cache.on('update', () => this.emit('update'));
        this.cumulativePackKey = CUMULATIVE_PACK_KEY;
        this.cumulativeGraphqlSchemaKey = CUMULATIVE_GRAPHQL_SCHEMA_KEY;
        this.cumulativePack = new cacheable_bucket_item_1.CacheableBucketItem({
            bucket: this.bucket,
            key: this.cumulativePackKey,
            ttl: 5 * MINUTE
        });
        this.cumulativeGraphqlSchema = new cacheable_bucket_item_1.CacheableBucketItem({
            bucket: this.bucket,
            key: this.cumulativeGraphqlSchemaKey,
            ttl: 5 * MINUTE
        });
    }
    get bucket() {
        return this.tradle.buckets.PrivateConf;
    }
    get models() {
        return this.cache.models;
    }
    getCustomModels() {
        return _.clone(this.myCustomModels);
    }
}
exports.ModelStore = ModelStore;
const getModelsPackConfKey = domainOrPack => {
    if (typeof domainOrPack === 'string') {
        return `${MODELS_FOLDER}/${domainOrPack}/pack.json`;
    }
    if (domainOrPack[constants_1.TYPE] === MODELS_PACK) {
        return getModelsPackConfKey(ModelsPack.getDomain(domainOrPack));
    }
    throw new Error('expected domain or ModelsPack');
};
exports.createModelStore = (tradle) => new ModelStore(tradle);
exports.toggleDomainVsNamespace = str => str.split('.').reverse().join('.');
exports.validateUpdate = (current, updated) => {
    const lost = _.difference(current, Object.keys(updated));
    if (lost.length) {
        throw new Error(`models cannot be removed, only deprecated: ${lost.join(', ')}`);
    }
};
const getCumulative = (modelStore, foreign, customOnly) => {
    const domestic = customOnly ? modelStore.getCustomModels() : modelStore.models;
    return Object.assign({}, utils_1.toModelsMap(_.get(foreign, 'models', [])), domestic);
};
//# sourceMappingURL=model-store.js.map