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
const engine_1 = require("@tradle/engine");
const Errors = require("./errors");
const utils_1 = require("./utils");
const crypto_1 = require("./crypto");
const string_utils_1 = require("./string-utils");
const types = require("./typeforce-types");
const constants_1 = require("./constants");
const { unserializeMessage } = engine_1.utils;
const { MESSAGE, IDENTITY, SELF_INTRODUCTION, INTRODUCTION, IDENTITY_PUBLISH_REQUEST } = constants_1.TYPES;
class Messages {
    constructor(opts) {
        this.normalizeInbound = (event) => {
            let message;
            if (Buffer.isBuffer(event)) {
                try {
                    message = unserializeMessage(event);
                }
                catch (err) {
                    this.debug('unable to unserialize message', event, err);
                    throw err;
                }
            }
            else {
                message = event;
            }
            const { recipientPubKey } = message;
            if (!recipientPubKey) {
                throw new Errors.InvalidMessageFormat('unexpected format');
            }
            const { pub } = recipientPubKey;
            if (!Buffer.isBuffer(pub)) {
                recipientPubKey.pub = new Buffer(pub.data);
            }
            validateInbound(message);
            return message;
        };
        this.getPropsDerivedFromLast = (last) => {
            const seq = last ? last.seq + 1 : 0;
            const props = { [constants_1.SEQ]: seq };
            if (last) {
                props[constants_1.PREV_TO_RECIPIENT] = last.link;
            }
            return props;
        };
        this.messageToEventPayload = (message) => {
            const neutered = this.stripData(message);
            return Object.assign({}, neutered, { recipientPubKey: this.serializePubKey(message.recipientPubKey) });
        };
        this.messageFromEventPayload = (event) => {
            return Object.assign({}, event, { recipientPubKey: this.unserializePubKey(event.recipientPubKey) });
        };
        this.serializePubKey = (key) => {
            return `${key.curve}:${key.pub.toString('hex')}`;
        };
        this.unserializePubKey = (key) => {
            const [curve, pub] = key.split(':');
            return {
                curve,
                pub: new Buffer(pub, 'hex')
            };
        };
        this.getMessageStub = (opts) => {
            const { message, error } = opts;
            const stub = {
                link: (error && error.link) || crypto_1.getLink(message),
                time: message.time
            };
            utils_1.typeforce(types.messageStub, stub);
            return stub;
        };
        this.stripData = (message) => {
            return Object.assign({}, message, { object: utils_1.pickVirtual(message.object) });
        };
        this.putMessage = (message) => __awaiter(this, void 0, void 0, function* () {
            utils_1.setVirtual(message, {
                _payloadType: message.object[constants_1.TYPE],
                _payloadLink: message.object._link,
                _payloadAuthor: message.object._author,
            });
            const item = this.messageToEventPayload(message);
            if (message._inbound) {
                yield this.putInboundMessage({ message, item });
            }
            else {
                yield this.putOutboundMessage({ message, item });
            }
        });
        this.putOutboundMessage = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { item } = opts;
            yield this.outbox.put({ Item: item });
        });
        this.putInboundMessage = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { item, message } = opts;
            const params = {
                Item: item,
                ConditionExpression: 'attribute_not_exists(#link)',
                ExpressionAttributeNames: {
                    '#link': '_link'
                }
            };
            try {
                yield this.inbox.put(params);
            }
            catch (err) {
                if (err.code === 'ConditionalCheckFailedException') {
                    const dErr = new Errors.Duplicate();
                    dErr.link = crypto_1.getLink(message);
                    throw dErr;
                }
                throw err;
            }
        });
        this.loadMessage = (message) => __awaiter(this, void 0, void 0, function* () {
            const body = yield this.objects.get(crypto_1.getLink(message.object));
            message.object = utils_1.extend(message.object || {}, body);
            return message;
        });
        this.getMessageFrom = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { author, time, link, body = true } = opts;
            if (body && link) {
                this.objects.prefetch(link);
            }
            return yield this.maybeAddBody({
                message: yield this.get(this.inbox, {
                    _author: author,
                    time
                }),
                body
            });
        });
        this.getMessagesFrom = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { author, gt, limit, body = true } = opts;
            this.debug(`looking up inbound messages from ${author}, > ${gt}`);
            const params = this.getMessagesFromQuery({ author, gt, limit });
            const messages = yield this.find(this.inbox, params);
            return body ? Promise.all(messages.map(this.loadMessage)) : messages;
        });
        this.getLastMessageFrom = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { author, body = true } = opts;
            const params = this.getLastMessageFromQuery({ author });
            return this.maybeAddBody({
                message: yield this.findOne(this.inbox, params),
                body
            });
        });
        this.maybeAddBody = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { message, body } = opts;
            return body ? this.loadMessage(message) : message;
        });
        this.getLastSeqAndLink = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { recipient } = opts;
            this.debug(`looking up last message to ${recipient}`);
            const query = this.getLastMessageToQuery({ recipient });
            let last;
            try {
                last = yield this.findOne(this.outbox, query);
                this.debug('last message:', string_utils_1.prettify(last));
                return {
                    seq: last[constants_1.SEQ],
                    link: last._link
                };
            }
            catch (err) {
                if (err instanceof Errors.NotFound) {
                    return null;
                }
                this.debug('experienced error in getLastSeqAndLink', err.stack);
                throw err;
            }
        });
        this.getMessagesTo = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { recipient, gt = 0, afterMessage, limit, body = true } = opts;
            if (afterMessage) {
                this.debug(`looking up outbound messages for ${recipient}, after ${afterMessage}`);
            }
            else {
                this.debug(`looking up outbound messages for ${recipient}, time > ${gt}`);
            }
            const params = this.getMessagesToQuery({ recipient, gt, afterMessage, limit });
            const messages = yield this.find(this.outbox, params);
            return body ? Promise.all(messages.map(this.loadMessage)) : messages;
        });
        this.getLastMessageTo = (opts) => __awaiter(this, void 0, void 0, function* () {
            const { recipient, body = true } = opts;
            const params = this.getLastMessageToQuery({ recipient });
            return this.maybeAddBody({
                message: yield this.findOne(this.outbox, params),
                body
            });
        });
        this.getInboundByLink = (link) => __awaiter(this, void 0, void 0, function* () {
            const keys = yield this.findOne(this.inbox, {
                IndexName: '_link',
                KeyConditionExpression: '#link = :link',
                ExpressionAttributeNames: {
                    '#link': '_link'
                },
                ExpressionAttributeValues: {
                    ':link': link
                },
                ScanIndexForward: true,
                Limit: 1
            });
            return this.get(this.inbox, keys);
        });
        this.assertTimestampIncreased = (message) => __awaiter(this, void 0, void 0, function* () {
            const link = crypto_1.getLink(message);
            const { time = 0 } = message;
            try {
                const prev = yield this.getLastMessageFrom({
                    author: message._author,
                    body: false
                });
                if (prev._link === link) {
                    const dErr = new Errors.Duplicate();
                    dErr.link = link;
                    throw dErr;
                }
                if (prev.time >= time) {
                    const msg = `timestamp for message ${link} is <= the previous messages's (${prev._link})`;
                    this.debug(msg);
                    const dErr = new Errors.TimeTravel(msg);
                    dErr.link = link;
                    throw dErr;
                }
            }
            catch (err) {
                if (!(err instanceof Errors.NotFound)) {
                    throw err;
                }
            }
        });
        this.parseInbound = (message) => __awaiter(this, void 0, void 0, function* () {
            const min = message;
            yield this.objects.resolveEmbeds(message);
            this.objects.addMetadata(message);
            this.objects.addMetadata(message.object);
            utils_1.setVirtual(min, utils_1.pickVirtual(message));
            utils_1.setVirtual(min.object, utils_1.pickVirtual(message.object));
            message = min;
            const payload = message.object;
            if (payload[constants_1.PREVLINK]) {
                this.objects.prefetch(payload[constants_1.PREVLINK]);
            }
            const addMessageAuthor = this.identities.addAuthorInfo(message);
            let addPayloadAuthor;
            if (payload._sigPubKey === message._sigPubKey) {
                addPayloadAuthor = addMessageAuthor.then(() => {
                    utils_1.setVirtual(payload, { _author: message._author });
                });
            }
            else {
                addPayloadAuthor = this.identities.addAuthorInfo(payload);
            }
            yield Promise.all([
                addMessageAuthor
                    .then(() => this.debug('loaded message author')),
                addPayloadAuthor
                    .then(() => this.debug('loaded payload author')),
            ]);
            if (payload[constants_1.PREVLINK]) {
                try {
                    yield this.objects.validateNewVersion({ object: payload });
                }
                catch (err) {
                    if (!(err instanceof Errors.NotFound)) {
                        throw err;
                    }
                    this.debug(`previous version of ${payload._link} (${payload[constants_1.PREVLINK]}) was not found, skipping validation`);
                }
            }
            this.debug('added metadata for message and wrapper');
            if (this.env.NO_TIME_TRAVEL) {
                yield this.assertTimestampIncreased(message);
            }
            utils_1.setVirtual(message, {
                _inbound: true
            });
            return message;
        });
        this.preProcessInbound = (event) => __awaiter(this, void 0, void 0, function* () {
            const message = this.normalizeInbound(event);
            if (message[constants_1.TYPE] !== MESSAGE) {
                throw new Errors.InvalidMessageFormat('expected message, got: ' + message[constants_1.TYPE]);
            }
            const { object } = message;
            const identity = getIntroducedIdentity(object);
            if (identity) {
                yield this.identities.validateAndAdd(identity);
            }
            return message;
        });
        this.get = (table, Key) => __awaiter(this, void 0, void 0, function* () {
            const message = yield table.get({ Key });
            return this.messageFromEventPayload(message);
        });
        this.findOne = (table, params) => __awaiter(this, void 0, void 0, function* () {
            let message = yield table.findOne(params);
            if (params.IndexName) {
                message = yield table.get({ Key: getKeys(message) });
            }
            return this.messageFromEventPayload(message);
        });
        this.find = (table, params) => __awaiter(this, void 0, void 0, function* () {
            let messages = yield table.find(params);
            if (params.IndexName) {
                messages = yield Promise.all(messages.map(keys => table.get({
                    Key: getKeys(keys)
                })));
            }
            return messages.map(this.messageFromEventPayload);
        });
        this.getMessagesFromQuery = ({ author, gt, limit }) => {
            const params = {
                TableName: this.inbox.name,
                KeyConditionExpression: '#author = :author AND #time > :time',
                ExpressionAttributeNames: {
                    '#author': '_author',
                    '#time': 'time'
                },
                ExpressionAttributeValues: {
                    ':author': author,
                    ':time': gt
                },
                ScanIndexForward: true
            };
            if (limit) {
                params.Limit = limit;
            }
            return params;
        };
        this.getLastMessageFromQuery = (opts) => {
            const { author } = opts;
            return {
                TableName: this.inbox.name,
                IndexName: '_author',
                KeyConditionExpression: '#author = :author AND #time > :time',
                ExpressionAttributeNames: {
                    '#author': '_author',
                    '#time': 'time'
                },
                ExpressionAttributeValues: {
                    ':author': author,
                    ':time': 0
                },
                ScanIndexForward: false,
                Limit: 1
            };
        };
        this.getMessagesToQuery = (opts) => {
            const { recipient, gt, afterMessage, limit } = opts;
            const params = {
                TableName: this.outbox.name,
                IndexName: '_recipient',
                KeyConditionExpression: `#recipient = :recipient AND #time > :time`,
                ExpressionAttributeNames: {
                    '#recipient': '_recipient',
                    '#time': 'time'
                },
                ExpressionAttributeValues: {
                    ':recipient': recipient,
                    ':time': gt
                },
                ScanIndexForward: true
            };
            if (afterMessage) {
                params.ExclusiveStartKey = afterMessage;
            }
            if (limit) {
                params.Limit = limit;
            }
            return params;
        };
        this.getLastMessageToQuery = (opts) => {
            const { recipient } = opts;
            return {
                TableName: this.outbox.name,
                IndexName: '_recipient',
                KeyConditionExpression: `#recipient = :recipient AND #time > :time`,
                ExpressionAttributeNames: {
                    '#recipient': '_recipient',
                    '#time': 'time'
                },
                ExpressionAttributeValues: {
                    ':recipient': recipient,
                    ':time': 0
                },
                ScanIndexForward: false,
                Limit: 1
            };
        };
        const { env, identities, objects, tables, db } = opts;
        this.env = env;
        this.debug = env.logger('messages');
        this.identities = identities;
        this.objects = objects;
        this.tables = tables;
        this.outbox = tables.Messages;
        this.inbox = tables.Messages;
        this.db = db;
    }
}
exports.default = Messages;
const validateInbound = (message) => {
    try {
        utils_1.typeforce(types.message, message);
    }
    catch (err) {
        throw new Errors.InvalidMessageFormat(err.message);
    }
};
const getIntroducedIdentity = (payload) => {
    const type = payload[constants_1.TYPE];
    if (type === IDENTITY)
        return payload;
    if (type === SELF_INTRODUCTION || type === INTRODUCTION || type === IDENTITY_PUBLISH_REQUEST) {
        return payload.identity;
    }
};
const getKeys = props => {
    return {
        _link: props._link
    };
};
//# sourceMappingURL=messages.js.map