require('../env').install()

import _ = require('lodash')
import test = require('tape')
import sinon = require('sinon')
import { TYPE, SIG, OWNER } from '@tradle/constants'
import buildResource = require('@tradle/build-resource')
import createProductsStrategy = require('@tradle/bot-products')
import { Remediation, idToStub, stubToId } from '../../in-house-bot/remediation'
import {
  createPlugin as createRemediationPlugin
} from '../../in-house-bot/plugins/remediation'
import {
  createPlugin as createPrefillFromDraftPlugin
} from '../../in-house-bot/plugins/prefill-from-draft'
import { loudAsync, parseStub } from '../../utils'
import Errors = require('../../errors')
import { Logger } from '../../logger'
import { createBot } from '../../bot'
import { TYPES } from '../../in-house-bot/constants'
import models = require('../../models')
import { IPBApp, IPBReq, IFormRequest } from '../../in-house-bot/types'

const users = require('../fixtures/users.json')
const dataBundle = require('../fixtures/data-bundle.json')

const {
  DATA_CLAIM,
  DATA_BUNDLE,
  FORM,
  APPLICATION,
  PRODUCT_REQUEST
} = TYPES

test('remediation plugin', loudAsync(async (t) => {
  const sandbox = sinon.createSandbox()
  const claim = {
    [TYPE]: DATA_CLAIM,
    [SIG]: 'somesig',
    claimId: stubToId({
      claimType: 'dump',
      key: 'abcd',
      nonce: '1234'
    })
  }

  const user = { id: 'bob' }
  const bot = createBot()
  const productsAPI = {
    sendSimpleMessage: sandbox.stub().resolves(),
    send: sandbox.stub().callsFake(async ({ to, object }) => {
      const { items } = object
      t.equal(items.length, dataBundle.items.length)
      t.ok(items.every(item => {
        const isForm = models[item[TYPE]].subClassOf === FORM
        return item[SIG] && (!isForm || item[OWNER] === user.id)
      }))
    })
  }

  const { api, plugin } = createRemediationPlugin({
    bot,
    productsAPI,
    logger: new Logger('test:remediation1')
  })

  sandbox.stub(api, 'getBundleByClaimId').callsFake(async (id) => {
    t.equal(id, claim.claimId)
    return dataBundle
  })

  sandbox.stub(api, 'onClaimRedeemed').callsFake(async ({ user, claimId }) => {
    t.equal(claimId, claim.claimId)
  })

  t.doesNotThrow(() => api.validateBundle(dataBundle))
  await plugin[`onmessage:${DATA_CLAIM}`]({
    user,
    payload: claim
  })

  t.equal(productsAPI.send.callCount, 1)
  sandbox.restore()
  t.end()
}))

test('remediation api', loudAsync(async (t) => {
  const sandbox = sinon.createSandbox()
  const bundle = {
    items: [
      {
        _t: 'tradle.WealthCV',
        narrative: 'got rich'
      },
      {
        _t: 'tradle.Verification',
        document: 0,
        dateVerified: 12345
      }
    ]
  }

  const user = { id: 'b5da273e0254479d5e611a1ded1effecf751e6e6588dc6648fc21f5e036961c0' }
  const bot = createBot()
  const remediation = new Remediation({
    bot,
    productsAPI: {
      plugins: {
        use: ({ onmessage }) => {}
      }
    },
    logger: new Logger('test:remediation')
  })

  const stub = await remediation.genClaimStub({ bundle, claimType: 'dump' })
  t.same(idToStub(stub.claimId), {
    key: stub.key,
    nonce: stub.nonce,
    claimType: 'dump',
    claimId: stub.claimId
  })

  const key = await remediation.saveUnsignedDataBundle(bundle)
  const { claimId } = await remediation.createClaim({ key, claimType: 'dump' })
  const saved = await remediation.getBundleByClaimId(claimId)
  t.same(saved, bundle)
  await remediation.onClaimRedeemed({ user, claimId })
  try {
    await remediation.getBundleByClaimId(claimId)
    t.fail('expected claim to have been deleted')
  } catch (err) {
    t.ok(Errors.matches(err, Errors.NotFound))
  }

  sandbox.restore()
  t.end()
}))

test('prefill-based', loudAsync(async (t) => {
  const sandbox = sinon.createSandbox()
  const userFixture = users[0]
  const user = {
    id: userFixture.link,
    identity: userFixture.identity
  }

  const bot = createBot()
  const unsignedForms = dataBundle.items.filter(item => models[item[TYPE]].subClassOf === FORM)
  const product = 'tradle.WealthManagementAccount'
  const productRequest = await bot.sign({
    [TYPE]: PRODUCT_REQUEST,
    requestFor: product,
    contextId: 'abc'
  })

  const forms = await Promise.all(unsignedForms.map(form => bot.sign(form)))
  const formStubs = forms.map(resource => buildResource.stub({ resource }))
  const objects = {}
  forms.concat(productRequest).forEach(res => {
    objects[buildResource.link(res)] = res
  })

  const productsAPI = createProductsStrategy({
    logger: bot.logger.sub('products'),
    bot,
    models: {
      all: models
    },
    products: [product],
    nullifyToDeleteProperty: true
  })

  // const productsAPI = {
  //   state: {
  //     createApplication: ({ user }) => {

  //     }
  //   },
  //   send: sandbox.stub().callsFake(async ({ to, object }) => {
  //   })
  // }

  const { api, plugin } = createRemediationPlugin({
    bot,
    productsAPI,
    logger: new Logger('test:remediation1')
  })

  sandbox.stub(bot.objects, 'get').callsFake(async (link) => {
    if (objects[link]) return objects[link]

    throw new Errors.NotFound(link)
  })

  // let bundle
  // sandbox.stub(api.store.bucket, 'put').callsFake(async (key, val) => {
  //   bundle = val
  // })

  // sandbox.stub(api.store, 'get').callsFake(async (key) => {
  //   return bundle
  // })

  let keyToClaimIds = {}
  sandbox.stub(api.keyToClaimIds, 'put').callsFake(async (key, val) => {
    keyToClaimIds[key] = val
  })

  sandbox.stub(api.keyToClaimIds, 'get').callsFake(async (key) => {
    if (keyToClaimIds[key]) return keyToClaimIds[key]

    throw new Errors.NotFound(key)
  })

  const draft = <IPBApp>{
    [TYPE]: APPLICATION,
    request: buildResource.stub({ resource: productRequest }),
    forms: formStubs,
    draft: true
  }

  const stub = await api.createClaimForApplication({
    claimType: 'prefill',
    application: draft
  })

  const prefillFromDraft = createPrefillFromDraftPlugin({
    bot,
    productsAPI,
    logger: new Logger('test:prefill-from-draft'),
    remediation: api
  })

  const req = <IPBReq>{}
  await api.handleDataClaim({
    req,
    user,
    claimId: stub.claimId
  })

  const { application } = req
  const formRequest = <IFormRequest>{
    form: forms[0][TYPE]
  }

  await prefillFromDraft.plugin.willRequestForm({
    to: user.id,
    application,
    formRequest
  })

  t.same(formRequest.prefill, unsignedForms[0])

  // sandbox.stub(api, 'getBundleByClaimId').callsFake(async (id) => {
  //   t.equal(id, claim.claimId)
  //   return dataBundle
  // })

  // sandbox.stub(api, 'onClaimRedeemed').callsFake(async ({ user, claimId }) => {
  //   t.equal(claimId, claim.claimId)
  // })

  sandbox.restore()
  t.end()
}))