import _ from 'lodash'
// @ts-ignore
import Promise from 'bluebird'
import buildResource from '@tradle/build-resource'
import validateResource from '@tradle/validate-resource'
import { TYPE } from '@tradle/constants'
import { utils as DDBUtils, OrderBy } from '@tradle/dynamodb'
import {
  parseStub,
  parsePermId,
  uniqueStrict,
  pluck,
  toPathValuePairs,
  getPermId,
  getResourceIdentifier,
  RESOLVED_PROMISE,
  isUnsignedType,
  allSettled,
  isWellBehavedIntersection
} from './utils'

import {
  ITradleObject,
  ITradleMessage,
  ModelStore,
  Models,
  Model,
  Middleware,
  DB,
  ResourceStub,
  ParsedResourceStub,
  ISaveEventPayload,
  Logger,
  Storage,
  IBacklinkItem,
  Identity
} from './types'

import { getRecordsFromEvent } from './db-utils'
import { Resource, getForwardLinks, getBacklinkProperties } from './resource'
import Errors from './errors'
import { TYPES } from './constants'
const { MESSAGE, BACKLINK_ITEM } = TYPES
const APPLICATION = 'tradle.Application'
const APPLICATION_SUBMISSION = 'tradle.ApplicationSubmission'
const { isDescendantOf, isInlinedProperty } = validateResource.utils
const SEPARATOR = ':'
const DEFAULT_BACKLINK_ORDER_BY = {
  property: '_time',
  desc: true
}

interface ResourceProperty extends ParsedResourceStub {
  property: string
}

type KVPairArr = [string, any]

export interface IResolvedBacklinkItem extends IBacklinkItem {
  backlinkProp: string
}

export type LatestToLink = {
  [latestId: string]: string
}

export type ResourceBacklinks = {
  [backlinkProperty: string]: ResourceStub[]
}

export type RemoveBacklinks = {
  [backlinkProperty: string]: string[]
}

export type BacklinksChange = {
  add: IBacklinkItem[]
  del: IBacklinkItem[]
}

type FetchBacklinksOpts = {
  type: string
  permalink: string
  properties?: string[]
  orderBy?: OrderBy
}

// export type Backlink = string[]

type BacklinksOpts = {
  storage: Storage
  modelStore: ModelStore
  logger: Logger
  identity: Identity
}

export default class Backlinks {
  private storage: Storage
  private db: DB
  private modelStore: ModelStore
  private logger: Logger
  private identity: Identity
  constructor ({ storage, modelStore, logger, identity }: BacklinksOpts) {
    this.storage = storage
    this.db = storage.db
    this.modelStore = modelStore
    this.logger = logger
    this.identity = identity
  }

  private get models() {
    return this.modelStore.models
  }

  public getForwardLinks = (resource):IBacklinkItem[] => {
    const { logger, models } = this
    return getForwardLinks({ logger, models, resource })
  }

  public fetchBacklinks = async ({
    type,
    permalink,
    properties,
    orderBy=DEFAULT_BACKLINK_ORDER_BY
  }: FetchBacklinksOpts):Promise<ResourceBacklinks> => {
    const { models } = this
    const filter = {
      IN: {},
      EQ: {
        [TYPE]: BACKLINK_ITEM,
        'target._permalink': permalink
      }
    }

    if (properties) {
      const targetModel = models[type]
      const sourceProps = properties.map(prop => {
        const { ref, backlink } = targetModel.properties[prop].items
        return backlink
      })

      filter.IN = {
        linkProp: sourceProps
      }
    }

    const { items } = await this.db.find({ filter })

    // BacklinkItem is tricky to index
    // sort in memory
    DDBUtils.sortResults({
      results: items,
      orderBy
    })

    return toResourceFormat({
      models,
      backlinkItems: items
    })
  }

  public processMessages = async (messages: ITradleMessage[]) => {
    this.logger.silly(`processing ${messages.length} messages`)

    messages = messages.filter(m => m.context && m.object[TYPE] !== MESSAGE)
    if (!messages.length) return

    const contexts = uniqueStrict(pluck(messages, 'context'))
    const applications = await this._getApplicationsWithContexts(contexts)
    const appByContext = applications.reduce((result, app) => {
      result[app.context] = app
      return result
    }, {})

    const submissions = messages.map(m => m.object)
    const applicationSubmissions = submissions.map((submission, i) => {
      const { context } = messages[i]
      const application = appByContext[context]
      if (!application) {
        this.logger.debug('application with context not found', { context })
        return
      }

      const appSub = new Resource({
        models: this.models,
        type: APPLICATION_SUBMISSION
      })

      appSub.set({ application, submission, context })
      if (submission._time) {
        appSub.set({ _time: submission._time })
      } else {
        this.logger.warn('missing _time', submission)
      }

      return appSub.toJSON()
    })
    .filter(_.identity)

    if (!applicationSubmissions.length) return []

    const results = await Promise.all(applicationSubmissions.map(async (object) => {
      object = await this.identity.sign({ object })
      try {
        object = await this.storage.save({ object })
      } catch (error) {
        this.logger.debug('failed to create application submission', {
          error,
          applicationSubmission: object
        })

        Errors.ignoreUnmetCondition(error)
        return
      }

      this.logger.silly(`intersection created`, {
        type: APPLICATION_SUBMISSION,
        x: [APPLICATION, object.submission[TYPE]],
        delay: Date.now() - object._time,
      })

      return object
    }))

    return results.filter(_.identity)
  }

  public processChanges = async (resourceChanges: ISaveEventPayload[]) => {
    this.logger.silly('processing resource changes', resourceChanges.map(r => _.pick(r.value, ['_t', '_permalink'])))

    resourceChanges = resourceChanges.filter(r => {
      const resource = r.value || r.old
      const type = resource[TYPE]
      if (type === BACKLINK_ITEM) return false

      const model = this.models[type]
      // well-behaved intersections can be queried directly
      // without backlink items
      return !isWellBehavedIntersection(model)
    })

    if (!resourceChanges.length) {
      return { add: [], del: [] }
    }

    const backlinkChanges = this.getBacklinksChanges(resourceChanges)
    const { add, del } = backlinkChanges
    if (!(add.length || del.length)) return backlinkChanges

    if (add.length) {
      this.logger.debug(`creating ${add.length} backlink items`)//, printItems(add))
    }

    if (del.length) {
      this.logger.debug(`deleting ${del.length} backlink items`)//, printItems(del))
    }

    const promiseAdd = add.length ? this.db.batchPut(add.map(this.toDBFormat)) : RESOLVED_PROMISE
    const promiseDel = del.length ? Promise.all(del.map(item => this.db.del(item))) : RESOLVED_PROMISE
    await Promise.all([promiseAdd, promiseDel])
    return backlinkChanges
  }

  private toDBFormat = (blItem:IBacklinkItem):any => _.omit(blItem, ['targetParsedStub', 'backlinkProp'])
  private fromDBFormat = (blItem:any):IBacklinkItem => ({
    ...blItem,
    targetParsedStub: {
      ...parsePermId(blItem.target),
      link: blItem.targetLink
    }
  })

  public getBacklinksChanges = (rChanges: ISaveEventPayload[]):BacklinksChange => {
    const { models, logger } = this
    return getBacklinkChangesForChanges({
      models,
      logger,
      changes: rChanges
    })
  }

  private _getPayload = async (message:ITradleMessage) => {
    return await this.db.get(message._payloadLink)
  }

  private _getApplicationsWithContexts = async (contexts:string[]) => {
    // context is indexed, so N queries by EQ (with hashKey) are more efficient
    // than an IN query that results in a scan
    this.logger.silly('searching for applications with contexts', contexts)
    const results = await allSettled(contexts.map(this._getApplicationWithContext))
    return results
      .filter(result => result.isFulfilled)
      .map(result => result.value)
  }

  private _getApplicationWithContext = async (context:string) => {
    return await this.db.findOne({
      // select: ['_link', '_permalink', 'context'],
      filter: {
        EQ: {
          [TYPE]: APPLICATION,
          context
        }
      }
    })
  }
}

// const updateBacklink = (ids:Backlink, id:string):Backlink => {
//   const stubs = ids.map(parseId)
//   const update = parseId(id)
//   const idx = stubs.findIndex(stub => stub.permalink === update.permalink)
//   if (idx === -1) {
//     return ids.concat(id)
//   }

//   if (stubs[idx].link === update.link) return ids

//   return ids.map((oldId, i) => i === idx ? id : oldId)
// }

// export const toBacklinks = (forwardLinks: IBacklinkItem[]):BacklinksContainer[] => {
//   const byTargetId = _.groupBy(forwardLinks, f => f.targetPermId)
//   return Object.keys(byTargetId).map(vId => {
//     const backlinks = {}
//     const byBacklinkProp = _.groupBy(byTargetId[vId], 'back')
//     for (let backlinkProp in byBacklinkProp) {
//       let backlink = backlinks[backlinkProp] = {}
//       let fLinks = byBacklinkProp[backlinkProp]
//       for (const fl of fLinks) {
//         backlink[fl.sourcePermId] = fl.sourceParsedStub.link
//       }
//     }

//     return {
//       // forwardLinks: byTargetId[vId],
//       targetId: vId,
//       backlinks
//     }
//   })
// }

// export const getBacklinkChanges = ({ before, after }: {
//   before?: BacklinksContainer
//   after?: BacklinksContainer
// }):BacklinksChange => {
//   if (!(before || after)) {
//     throw new Errors.InvalidInput('expected "before" and/or "after"')
//   }

//   const { targetId } = before || after
//   const set:StoredResourceBacklinks = {}
//   const remove:RemoveBacklinks = {}
//   concatKeysUniq(
//     before && before.backlinks,
//     after && after.backlinks
//   ).forEach(backlink => {
//     const toSet = {}
//     const toRemove = []
//     const pre = before && before.backlinks[backlink]
//     const post = after && after.backlinks[backlink]
//     if (pre && post) {
//       concatKeysUniq(pre, post).forEach(latestId => {
//         if (post[latestId] === pre[latestId]) return
//         if (post[latestId]) {
//           if (post[latestId] !== pre[latestId]) {
//             toSet[latestId] = post[latestId]
//           }
//         } else {
//           toRemove.push(latestId)
//         }
//       })
//     } else if (pre) {
//       toRemove.push(...Object.keys(pre))
//     } else if (post) {
//       _.extend(toSet, post)
//     }

//     if (!_.isEmpty(toSet)) set[backlink] = toSet
//     if (!_.isEmpty(toRemove)) remove[backlink] = toRemove
//   })

//   if (_.isEmpty(set) && _.isEmpty(remove)) return

//   return {
//     targetId,
//     set,
//     remove
//   }
// }

// const removeBacklinksToPaths = (backlinks: RemoveBacklinks):string[][] => {
//   const paths = []
//   Object.keys(backlinks).map(backlink => {
//     const path = backlinks[backlink].map(latestId => [backlink, latestId])
//     paths.push(path)
//   })

//   return _.flatten(paths)
// }

const concatKeysUniq = (...objs): string[] => {
  const keyMap = {}
  for (const obj of objs) {
    if (obj) {
      for (let key in obj) keyMap[key] = true
    }
  }

  return Object.keys(keyMap)
}

export const getBacklinkChangesForChanges = ({ models, logger, changes }: {
  models: Models
  changes: ISaveEventPayload[]
  logger?: Logger
}) => {
  let forwardBefore = _.flatMap(changes, ({ value, old }) => {
    return old ? getForwardLinks({ models, logger, resource: old }) : []
  })

  forwardBefore = _.uniqBy(forwardBefore, toUid)

  let forwardAfter = _.flatMap(changes, ({ value, old }) => {
    return value ? getForwardLinks({ models, logger, resource: value }) : []
  })

  forwardAfter = _.uniqBy(forwardAfter, toUid)

  const fAfterUids = forwardAfter.map(toUid)
  // no sense in deleting what we'll be overwriting
  const del = forwardBefore.filter(fl => !fAfterUids.includes(toUid(fl)))
  return {
    add: forwardAfter,
    del
  }
}

export { Backlinks }
export const createBacklinks = (opts: BacklinksOpts) => new Backlinks(opts)

const toUid = (fl:IBacklinkItem) => [fl.linkProp, fl.source._permalink, fl.target._permalink].join(':')
const toResourceFormat = ({ models, backlinkItems }: {
  models: Models
  backlinkItems: IBacklinkItem[]
}):ResourceBacklinks => {
  const resolved = <KVPairArr>_.flatMap(backlinkItems, bl => {
    const { linkProp, source, target } = bl
    const sourceModel = models[source[TYPE]]
    const targetModel = models[target[TYPE]]
    const backlinkProps = getBacklinkProperties({
      models,
      sourceModel,
      targetModel,
      linkProp
    })

    return backlinkProps.map(backlinkProp => [backlinkProp, source])
  })

  return resolved.reduce((backlinks, [backlinkProp, value]) => {
    if (!backlinks[backlinkProp]) {
      backlinks[backlinkProp] = []
    }

    backlinks[backlinkProp].push(value)
    return backlinks
  }, <ResourceBacklinks>{})
}

// const printItems = blItems => JSON.stringify(blItems.map(item => _.pick(item, ['source', 'target']), null, 2))
