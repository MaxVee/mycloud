"use strict";
const dynamodb_1 = require("@tradle/dynamodb");
module.exports = function createDB(opts) {
    const { models, objects, tables, aws, constants, env, prefix } = opts;
    const readOnlyObjects = {
        get: objects.get,
        put: objects.put
    };
    const db = dynamodb_1.db({
        models,
        objects: readOnlyObjects,
        docClient: aws.docClient,
        maxItemSize: constants.MAX_DB_ITEM_SIZE,
        prefix
    });
    const messageModel = models['tradle.Message'];
    if (!messageModel.isInterface) {
        const messagesTable = dynamodb_1.createTable({
            models,
            objects: readOnlyObjects,
            bodyInObjects: false,
            forbidScan: true,
            model: messageModel,
            tableName: tables.Messages.name,
            prefix,
            hashKey: '_link',
            indexes: [
                {
                    hashKey: '_author',
                    rangeKey: 'time',
                    name: '_author',
                    type: 'global',
                    projection: {
                        ProjectionType: 'KEYS_ONLY'
                    }
                },
                {
                    hashKey: '_recipient',
                    rangeKey: 'time',
                    name: '_recipient',
                    type: 'global',
                    projection: {
                        ProjectionType: 'KEYS_ONLY'
                    }
                },
                {
                    hashKey: '_payloadLink',
                    name: '_payloadLink',
                    type: 'global',
                    projection: {
                        ProjectionType: 'KEYS_ONLY'
                    }
                }
            ]
        });
        db.setTableForType('tradle.Message', messagesTable);
    }
    const pubKeyModel = models['tradle.PubKey'];
    const pubKeys = dynamodb_1.createTable({
        models: Object.assign({}, models, { [pubKeyModel.id]: pubKeyModel }),
        objects: readOnlyObjects,
        model: pubKeyModel,
        tableName: tables.PubKeys.name,
        prefix,
        hashKey: 'pub',
        indexes: []
    });
    db.setTableForType('tradle.PubKey', pubKeys);
    return db;
};
//# sourceMappingURL=db.js.map