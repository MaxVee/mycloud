import _ = require('lodash')
import { TYPE, SIG } from '@tradle/constants'
import {
  IPluginOpts,
  IPluginExports,
  IPluginLifecycleMethods,
  IDataBundle,
  IUser,
  IPBApp,
  IPBReq
} from '../types'

import { parseStub, omitVirtual, toUnsigned } from '../../utils'
import Errors = require('../../errors')

interface RequestItemOpts {
  req: IPBReq
  user: IUser
  item: any
  application?: IPBApp
  message?: string
  other?: any
}

export const name = 'prefillFromDraft'
export function createPlugin ({
  bot,
  productsAPI,
  // inviter,
  conf,
  orgConf,
  logger
}: IPluginOpts):IPluginExports {

  const plugin:IPluginLifecycleMethods = {}
  plugin.willRequestForm = async ({ user, application, formRequest }) => {
    if (!(application && application.prefillFromApplication)) return

    const model = bot.models[formRequest.form]
    if (model && model.notShareable) return

    let draft
    try {
      draft = await bot.getResourceByStub(application.prefillFromApplication)
    } catch (err) {
      Errors.rethrow(err, 'developer')
      logger.error(`application draft not found`, err)
      return
    }

    // TODO: be smart about multi-entry
    const { form } = formRequest
    const filledAlready = (application.forms || [])
      .map(parseStub)
      .filter(({ type }) => type === form)

    const idx = filledAlready.length
    const draftStubs = draft.forms.map(parseStub)
    const match = draftStubs.filter(({ type }) => type === form)[idx]
    if (!match) return

    let prefill
    try {
      prefill = await bot.objects.get(match.link)
    } catch (err) {
      Errors.rethrow(err, 'developer')
      logger.error(`form draft not found`, err)
      return
    }

    logger.debug('setting prefill from draft application', {
      form,
      user: user.id,
      application: application._permalink
    })

    formRequest.prefill = toUnsigned(prefill)
  }

//   plugin.onFormsCollected = async ({ req, user, application }) => {
//     if (!application.draft) return

//     const productModel = bot.models[application.requestFor]
//     const opts: RequestItemOpts = {
//       req,
//       user,
//       application,
//       message: `Who shall we email an invite to this application?`,
//       item: {
//         [TYPE]: 'tradle.FormRequest',
//         form: 'tradle.cloud.Invite',
//         prefill: {
//           [TYPE]: 'tradle.cloud.Invite',
//           inviteLink: bot.appLinks.getApplyForProductLink({
//             host: bot.apiBaseUrl,
//             product: application.requestFor
//           }),
//           body: `Hi there,

// We've prefilled some of the forms an application for a ${productModel.title} for you.

// Have any questions? Ask us right in our chat channel!`,
//           buttonText: 'Open Application'
//         }
//       }
//     }

//     await productsAPI.requestItem(opts)
//   }

//   plugin[`onmessage:tradle.cloud.Invite`] = async (req) => {
//     const { user, application, payload, isFromEmployee } = req
//     if (!isFromEmployee) return

//     await inviter.sendInvite(payload)
//   }

  return {
    plugin
  }
}
