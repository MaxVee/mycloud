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
const baseModels = require("../../models");
const utils_1 = require("../../utils");
const BASE_MODELS_IDS = Object.keys(baseModels);
const mapModelsToPack = new Map();
exports.defaultPropertyName = 'modelsHash';
exports.getDefaultIdentifierFromUser = (user) => user.id;
exports.getDefaultIdentifierFromReq = ({ user }) => exports.getDefaultIdentifierFromUser(user);
exports.keepModelsFreshPlugin = ({ getModelsPackForUser, propertyName = exports.defaultPropertyName, getIdentifier = exports.getDefaultIdentifierFromReq, send }) => {
    return (req) => __awaiter(this, void 0, void 0, function* () {
        const identifier = getIdentifier(req);
        const { user } = req;
        let modelsPack = getModelsPackForUser(user);
        if (utils_1.isPromise(modelsPack)) {
            modelsPack = yield modelsPack;
        }
        if (!modelsPack)
            return;
        yield exports.sendModelsPackIfUpdated({
            user,
            modelsPack,
            propertyName,
            identifier,
            send: object => send({ req, to: user, object })
        });
    });
};
exports.sendModelsPackIfUpdated = ({ user, modelsPack, send, identifier, propertyName = exports.defaultPropertyName, }) => __awaiter(this, void 0, void 0, function* () {
    if (!identifier)
        identifier = exports.getDefaultIdentifierFromUser(user);
    if (!user[propertyName] || typeof user[propertyName] !== 'object') {
        user[propertyName] = {};
    }
    const versionId = user[propertyName][identifier];
    if (modelsPack.versionId === versionId)
        return;
    user[propertyName][identifier] = modelsPack.versionId;
    return yield send(modelsPack);
});
exports.createGetIdentifierFromReq = ({ employeeManager }) => {
    return req => {
        const { user, message } = req;
        const { originalSender } = message;
        let identifier = exports.getDefaultIdentifierFromUser(user);
        if (originalSender) {
            identifier += ':' + originalSender;
        }
        return identifier;
    };
};
exports.createModelsPackGetter = ({ bot, productsAPI, employeeManager }) => {
    return (user) => __awaiter(this, void 0, void 0, function* () {
        if (employeeManager.isEmployee(user)) {
            return yield bot.modelStore.getCumulativeModelsPack();
        }
        return bot.modelStore.myModelsPack;
    });
};
//# sourceMappingURL=keep-models-fresh.js.map