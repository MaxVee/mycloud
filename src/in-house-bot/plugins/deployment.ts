import { selectModelProps } from '../../utils'
import {
  IPluginOpts,
  CreatePlugin,
  IDeploymentConf,
  IDeploymentPluginConf,
  IPBReq,
  ValidatePluginConf,
  UpdatePluginConf,
} from '../types'

import Errors from '../../errors'
import constants from '../../constants'
import { Deployment, createDeployment } from '../deployment'
import { TYPES } from '../constants'
import { getParsedFormStubs } from '../utils'

const { TYPE, WEB_APP_URL } = constants
const templateFileName = 'compiled-cloudformation-template.json'
const { DEPLOYMENT_PRODUCT, DEPLOYMENT_CONFIG_FORM, SIMPLE_MESSAGE } = TYPES

export interface IDeploymentPluginOpts extends IPluginOpts {
  conf: IDeploymentPluginConf
}

export const createPlugin:CreatePlugin<Deployment> = (components, { conf, logger }:IDeploymentPluginOpts) => {
  const { bot, applications, productsAPI, employeeManager } = components
  const orgConf = components.conf
  const { org } = orgConf
  const deployment = createDeployment({ bot, logger, conf, org })
  const getBotPermalink = bot.getPermalink()
  const onFormsCollected = async ({ req, user, application }) => {
    if (application.requestFor !== DEPLOYMENT_PRODUCT) return

    let form
    if (req && req.payload && req.payload[TYPE] === DEPLOYMENT_CONFIG_FORM) {
      form = req.payload
    } else {
      const latest = getParsedFormStubs(application).reverse()
        .find(({ type }) => type === DEPLOYMENT_CONFIG_FORM)

      const { link } = latest
      form = await bot.objects.get(link)
    }

    const link = form._link
    const configuration = Deployment.parseConfigurationForm(form)
    const botPermalink = await getBotPermalink
    const deploymentOpts = {
      ...configuration,
       // backwards compat
      stackName: configuration.stackName || configuration.stackPrefix,
      configurationLink: link,
    } as IDeploymentConf

    // async
    bot.sendSimpleMessage({
      to: user,
      message: `Generating a template and code package for your MyCloud. This could take up to 30 seconds...`
    })

    let launchUrl
    try {
      launchUrl = (await deployment.genLaunchPackage(deploymentOpts)).url
    } catch (err) {
      if (!Errors.matches(err, Errors.InvalidInput)) {
        logger.error('failed to generate launch url', err)
        await productsAPI.sendSimpleMessage({
          req,
          to: user,
          message: `hmm, something went wrong, we'll look into it`
        })

        return
      }

      logger.debug('failed to generate launch url', err)
      await applications.requestEdit({
        req,
        item: selectModelProps({ object: form, models: bot.models }),
        details: {
          message: err.message
        }
      })

      return
    }

    logger.debug('generated launch url', { launchUrl })
    await productsAPI.sendSimpleMessage({
      req,
      to: user,
      message: `🚀 [Click to launch your MyCloud](${launchUrl})`
      // \n\nInvite employees using this link: ${employeeOnboardingUrl}`
    })

    if (!conf.senderEmail) {
      logger.debug('unable to send email to AWS admin as conf is missing "senderEmail"')
      return
    }

    const { adminEmail } = form
    try {
      await bot.mailer.send({
        from: conf.senderEmail,
        to: adminEmail,
        ...deployment.genLaunchEmail({
          launchUrl,
          fromOrg: org
        })
      })
    } catch (err) {
      logger.error(`failed to send email to admin`, {
        deploymentOpts,
        error: err.stack
      })

      return
    }

    try {
      await productsAPI.sendSimpleMessage({
        req,
        to: user,
        message: `We've sent the respective link(s) to the designated AWS Admin (${adminEmail})`
      })
    } catch (err) {
      logger.error('failed to send notification to chat', err)
    }
  }

  return {
    api: deployment,
    plugin: {
      onFormsCollected,
      'onmessage:tradle.cloud.UpdateRequest': async (req: IPBReq) => {
        try {
          await deployment.handleUpdateRequest({
            req: req.payload,
            from: req.user
          })
        } catch (err) {
          Errors.ignoreNotFound(err)
          logger.debug('version not found', Errors.export(err))
        }
      },
      'onmessage:tradle.cloud.UpdateResponse': async (req: IPBReq) => {
        await deployment.handleUpdateResponse(req.payload)
      }
    }
  }
}

export const validateConf:ValidatePluginConf = async ({ bot, pluginConf }) => {
  const { senderEmail } = pluginConf as IDeploymentPluginConf
  if (senderEmail) {
    const resp = await bot.mailer.canSendFrom(senderEmail)
    if (!resp.result) {
      throw new Error(resp.reason)
    }
  }
}

export const updateConf:UpdatePluginConf = async ({ bot, pluginConf }) => {
  const { replication } = pluginConf as IDeploymentPluginConf
  if (!replication) return

  const { regions } = replication
  const { logger } = bot
  const deployment = createDeployment({ bot, logger })
  await deployment.createRegionalDeploymentBuckets({
    regions: regions.filter(r => r !== bot.env.AWS_REGION)
  })
}
