import { EventEmitter} from 'events'
import _ = require('lodash')
import mergeModels = require('@tradle/merge-models')
import ModelsPack = require('@tradle/models-pack')
import { TYPE } from '@tradle/constants'
import {
  createModelStore as createStore,
  ModelStore as DBModelStore
} from '@tradle/dynamodb'
import Logger from './logger'
import Friends from './friends'
import { Buckets } from './buckets'
import { CacheableBucketItem } from './cacheable-bucket-item'
import Errors = require('./errors')
import Tradle from './tradle'
import { Bucket } from './bucket'
import {
  PRIVATE_CONF_BUCKET
} from './constants'

import {
  toModelsMap
} from './utils'

const CUMULATIVE_PACK_KEY = PRIVATE_CONF_BUCKET.modelsPack
const CUMULATIVE_GRAPHQL_SCHEMA_KEY = PRIVATE_CONF_BUCKET.graphqlSchema
const MODELS_PACK = 'tradle.ModelsPack'
const MODELS_PACK_CACHE_MAX_AGE = 60000
const MODELS_FOLDER = 'models'
const BUILT_IN_NAMESPACES = [
  'tradle',
  'io.tradle'
]

const MINUTE = 60000

const firstValue = obj => {
  for (let key in obj) return obj[key]
}

// type CacheablePacks = {
//   [domain:string]: CacheableBucketItem
// }

export type ModelsPackInput = {
  models: any
  namespace?: string
}

export class ModelStore extends EventEmitter {
  public cumulativePackKey: string
  public cumulativeGraphqlSchemaKey: string
  public cumulativePack: CacheableBucketItem
  public cumulativeGraphqlSchema: CacheableBucketItem
  public myModelsPack: any
  private tradle: Tradle
  private logger: Logger
  private cache: DBModelStore
  private myDomain: string
  private myNamespace: string
  private myCustomModels: any
  private baseModels: any
  private baseModelsIds: string[]
  constructor (tradle:Tradle) {
    super()

    this.tradle = tradle
    this.logger = tradle.logger.sub('modelstore')
    this.baseModels = tradle.models
    this.baseModelsIds = Object.keys(this.baseModels)
    this.myCustomModels = {}
    this.cache = createStore({
      models: this.baseModels,
      onMissingModel: this.onMissingModel.bind(this)
    })

    this.cache.on('update', () => this.emit('update'))
    this.cumulativePackKey = CUMULATIVE_PACK_KEY
    this.cumulativeGraphqlSchemaKey = CUMULATIVE_GRAPHQL_SCHEMA_KEY
    this.cumulativePack = new CacheableBucketItem({
      bucket: this.bucket,
      key: this.cumulativePackKey,
      ttl: 5 * MINUTE
    })

    this.cumulativeGraphqlSchema = new CacheableBucketItem({
      bucket: this.bucket,
      key: this.cumulativeGraphqlSchemaKey,
      ttl: 5 * MINUTE
    })
  }

  public get bucket():Bucket {
    return this.tradle.buckets.PrivateConf
  }

  public get = async (id) => {
    const namespace = ModelsPack.getNamespace(id)
    if (ModelsPack.isReservedNamespace(namespace)) {
      return this.cache.models[id]
    }

    return await this.cache.get(id)
  }

  public get models () {
    return this.cache.models
  }

  public getCustomModels () {
    return _.clone(this.myCustomModels)
  }

  /**
   * Add a models pack to the cumulative models pack
   * update related resources (e.g. graphql schema)
   */
  public addModelsPack = async ({
    modelsPack,
    validateAuthor=true,
    validateUpdate=true
  }: {
    modelsPack: any,
    validateAuthor?: boolean,
    validateUpdate?: boolean,
  }) => {
    if (validateAuthor) {
      await this.validateModelsPackNamespaceOwner(modelsPack)
    }

    if (validateUpdate) {
      await this.validateModelsPackUpdate(modelsPack)
    }

    const current = await this.getCumulativeModelsPack()
    let cumulative
    if (current) {
      const { namespace } = modelsPack
      const models = current.models
        .filter(model => ModelsPack.getNamespace(model) !== namespace)
        .concat(modelsPack.models)

      cumulative = ModelsPack.pack({ models })
    } else {
      cumulative = modelsPack
    }

    await Promise.all([
      this.bucket.gzipAndPut(this.cumulativePackKey, cumulative),
      this.updateGraphqlSchema({ cumulativeModelsPack: cumulative })
    ])

    return cumulative
  }

  public updateGraphqlSchema = async (opts:any={}) => {
    let { cumulativeModelsPack } = opts
    if (!cumulativeModelsPack) cumulativeModelsPack = await this.getCumulativeModelsPack()

    const models = getCumulative(this, cumulativeModelsPack, false)
    const { exportSchema } = require('./bot/graphql')
    const schema = exportSchema({ models })
    await this.bucket.gzipAndPut(this.cumulativeGraphqlSchemaKey, schema)
  }

  public loadModelsPacks = async () => {
    const cumulative = await this.getCumulativeModelsPack()
    if (cumulative) {
      _.each(cumulative, ({ models }) => this.addModels(models))
    }
  }

  public getCumulativeModelsPack = async () => {
    try {
      return await this.bucket.getJSON(this.cumulativePackKey)
    } catch (err) {
      Errors.ignore(err, Errors.NotFound)
      return null
    }
  }

  public getSavedGraphqlSchema = async () => {
    const schema = await this.bucket.getJSON(this.cumulativeGraphqlSchemaKey)
    return require('./bot/graphql').importSchema(schema)
  }

  public getGraphqlSchema = async () => {
    try {
      return await this.getSavedGraphqlSchema()
    } catch (err) {
      Errors.ignore(err, Errors.NotFound)
      return require('./bot/graphql').exportSchema({
        models: this.models
      })
    }
  }

  public getModelsForNamespace = (namespace:string) => {
    const prefix = namespace + '.'
    const models = _.filter(this.models, (value:any, key:string) => key.startsWith(prefix))
    return ModelsPack.pack({ namespace, models })
  }

  public saveCustomModels = async (opts: ModelsPackInput) => {
    const { namespace, models } = opts
    // if (!namespace) namespace = this.myNamespace
    if (namespace) {
      this.setMyNamespace(namespace)
    }

    this.setCustomModels(opts)

    await this.addModelsPack({
      validateAuthor: false,
      modelsPack: this.myModelsPack
    })
  }

  public setCustomModels = ({ models, namespace }: ModelsPackInput) => {
    // ModelsPack.validate(ModelsPack.pack({ models }))
    const first = firstValue(models)
    if (!first) return

    if (!namespace) {
      namespace = this.myNamespace || ModelsPack.getNamespace(first)
    }

    // validate
    mergeModels()
      .add(this.baseModels, { validate: false })
      .add(models)

    const pack = ModelsPack.pack({ namespace, models })
    ModelsPack.validate(pack)

    this.cache.removeModels(this.myCustomModels)
    this.addModels(models)
    this.myModelsPack = pack
    this.myNamespace = namespace
    this.myCustomModels = _.clone(models)
  }

  public setMyNamespace = (namespace:string) => {
    this.myNamespace = namespace
    this.myDomain = toggleDomainVsNamespace(namespace)
  }

  public setMyDomain = (domain:string) => {
    this.myDomain = domain
    this.myNamespace = toggleDomainVsNamespace(domain)
  }

  // public buildMyModelsPack = () => {
  //   const models = this.getCustomModels()
  //   const namespace = this.myNamespace || ModelsPack.getNamespace(_.values(models))
  //   return ModelsPack.pack({ namespace, models })
  // }

  public addModels = (models) => {
    this.cache.addModels(models)
  }

  public getModelsPackByDomain = async (domain) => {
    return await this.bucket.getJSON(getModelsPackConfKey(domain))
  }

  public validateModelsPackNamespaceOwner = async (pack) => {
    if (!pack.namespace) {
      throw new Error(`ignoring ModelsPack sent by ${pack._author}, as it isn't namespaced`)
    }

    const domain = ModelsPack.getDomain(pack)
    const friend = await this.tradle.friends.getByDomain(domain)
    if (!pack._author) {
      await this.tradle.identities.addAuthorInfo(pack)
    }

    if (friend._identityPermalink !== pack._author) {
      throw new Error(`ignoring ModelsPack sent by ${pack._author}.
Domain ${domain} (and namespace ${pack.namespace}) belongs to ${friend._identityPermalink}`)
    }
  }

  public validateModelsPackUpdate = async (pack) => {
    const ret = {
      changed: true
    }

    const domain = ModelsPack.getDomain(pack)
    try {
      const current = await this.getModelsPackByDomain(domain)
      validateUpdate(current, pack)
      ret.changed = current.versionId !== pack.versionId
    } catch (err) {
      Errors.ignore(err, Errors.NotFound)
    }

    return ret
  }

  public validateModelsPack = async (modelsPack) => {
    await this.validateModelsPackNamespaceOwner(modelsPack)
    return await this.validateModelsPackUpdate(modelsPack)
  }

  /**
   * Save a models pack to storage
   */
  public saveModelsPack = async ({ modelsPack }) => {
    const { changed } = await this.validateModelsPack(modelsPack)
    if (!changed) return

    await this.bucket.gzipAndPut(getModelsPackConfKey(modelsPack), modelsPack)
    // await this.addModelsPack({ modelsPack })
  }

  private onMissingModel = async (id):Promise<void> => {
    const modelsPack = await this.getModelsPackByDomain(ModelsPack.getDomain(id))
    this.cache.addModels(modelsPack.models)
  }
}

const getModelsPackConfKey = domainOrPack => {
  if (typeof domainOrPack === 'string') {
    return `${MODELS_FOLDER}/${domainOrPack}/pack.json`
  }

  if (domainOrPack[TYPE] === MODELS_PACK) {
    return getModelsPackConfKey(ModelsPack.getDomain(domainOrPack))
  }

  throw new Error('expected domain or ModelsPack')
}

export const createModelStore = (tradle:Tradle) => new ModelStore(tradle)
export const toggleDomainVsNamespace = str => str.split('.').reverse().join('.')
export const validateUpdate = (current, updated) => {
  const lost = _.difference(current, Object.keys(updated))
  if (lost.length) {
    throw new Error(`models cannot be removed, only deprecated: ${lost.join(', ')}`)
  }
}

const getCumulative = (modelStore:ModelStore, foreign, customOnly) => {
  const domestic = customOnly ? modelStore.getCustomModels() : modelStore.models
  return {
    ...toModelsMap(_.get(foreign, 'models', [])),
    ...domestic
  }
}
