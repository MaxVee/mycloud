// import _ from 'lodash'
// import validateResource from '@tradle/validate-resource'
import { TYPE } from '@tradle/constants'
import {
  isPassedCheck
} from '../utils'

import {
  Bot,
  CreatePlugin,
  IPluginLifecycleMethods,
  ValidatePluginConf,
  ITradleCheck,
  IPBApp,
  Applications,
  Logger,
} from '../types'

// const { parseStub } = validateResource.utils

// export const name = 'conditional-auto-approve'

const getResourceType = resource => resource[TYPE]

interface IConditionalAutoApproveConf {
  [product: string]: {
    [targetCheck: string]: string []
  }
}

type ConditionalAutoApproveOpts = {
  bot: Bot
  conf: IConditionalAutoApproveConf
  applications: Applications
  logger: Logger
}

export class ConditionalAutoApprove {
  private bot: Bot
  private conf: IConditionalAutoApproveConf
  private applications: Applications
  private logger: Logger
  constructor({ bot, conf, applications, logger }: ConditionalAutoApproveOpts) {
    this.bot = bot
    this.conf = conf
    this.applications = applications
    this.logger = logger
  }

  public checkTheChecks = async ({ check }) => {
    this.logger.debug('checking if all checks passed')
    const application = await this.bot.getResource(check.application, {backlinks: ['checks']})
    const product = application.requestFor

    const checksToCheck = this.conf.products[product]
    if (!checksToCheck) {
      this.logger.debug(`not configured for product: ${product}`)
      return
    }

    const thisCheckType = check[TYPE]
    if (!checksToCheck.includes(thisCheckType)) {
      this.logger.debug(`ignoring check ${thisCheckType}, not relevant for auto-approve`)
      return
    }

    const checkResources = await this.applications.getLatestChecks({ application })
    // check that just passed may not have had correponding ApplicationSubmission created yet
    // and so may not be in the result
    const idx = checkResources.findIndex(c => c._permalink === check._permalink)
    if (idx === -1) {
      checkResources.push(check)
    } else {
      checkResources[idx] = check
    }

    const foundChecks = checkResources.filter(check => {
      return isPassedCheck(check) && checksToCheck.includes(check[TYPE])
    })

    if (foundChecks.length !== checksToCheck.length) {
      this.logger.debug('not ready to auto-approve', {
        product,
        passed: foundChecks.map(getResourceType),
        required: checksToCheck.map(getResourceType),
      })

      return
    }

    this.logger.debug('auto-approving application')
    await this.applications.approve({ application })
  }
}

export const createPlugin: CreatePlugin<void> = ({ bot, applications }, { conf, logger }) => {
  const autoApproveAPI = new ConditionalAutoApprove({ bot, conf, applications, logger })
  const plugin: IPluginLifecycleMethods = {
    onCheckStatusChanged: async (check: ITradleCheck) => {
      if (isPassedCheck(check)) {
        await autoApproveAPI.checkTheChecks({ check })
      }
    }
  }

  return { plugin }
}

export const validateConf:ValidatePluginConf = async ({ bot, conf, pluginConf }) => {
  const { models } = bot
  // debugger
  for (let appType in <IConditionalAutoApproveConf>pluginConf) {
    let checks = pluginConf[appType]
    for (let target in checks) {
      if (!models[target]) throw new Error(`missing model: ${target}`)

      let sources = checks[target]
      sources.forEach(source => {
        if (!models[source]) throw new Error(`missing model: ${source}`)
      })
    }
  }
}