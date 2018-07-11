import _ from 'lodash'
// @ts-ignore
import Promise from 'bluebird'
import AWS from 'aws-sdk'
import buildResource from '@tradle/build-resource'
import { TYPE, unitToMillis } from '../constants'
import { randomStringWithLength } from '../crypto'
import { appLinks } from '../app-links'
import {
  Env,
  Bot,
  Logger,
  ITradleObject,
  IIdentity,
  IPluginOpts,
  IDeploymentConf,
  IMyDeploymentConf,
  IDeploymentConfForm,
  ILaunchReportPayload,
  IKeyValueStore,
  ResourceStub,
  IOrganization,
  IDeploymentPluginConf,
  IConf,
  IAppLinkSet,
  StackStatus,
} from './types'

import { StackUtils } from '../stack-utils'
import { Bucket } from '../bucket'
import { media } from './media'
import Errors from '../errors'
import { getFaviconUrl } from './image-utils'
import * as utils from '../utils'
import * as Templates from './templates'
import { getAppLinks, getAppLinksInstructions, isEmployee } from './utils'

const TMP_SNS_TOPIC_TTL = unitToMillis.day
const LAUNCH_MESSAGE = 'Launch your Tradle MyCloud'
const ONLINE_MESSAGE = 'Your Tradle MyCloud is online!'
const CHILD_DEPLOYMENT = 'tradle.cloud.ChildDeployment'
const PARENT_DEPLOYMENT = 'tradle.cloud.ParentDeployment'
const CONFIGURATION = 'tradle.cloud.Configuration'
const AWS_REGION = 'tradle.cloud.AWSRegion'
const TMP_SNS_TOPIC = 'tradle.cloud.TmpSNSTopic'
const UPDATE_REQUEST = 'tradle.cloud.UpdateRequest'
const UPDATE_RESPONSE = 'tradle.cloud.UpdateResponse'
const NO_SENDER_EMAIL = 'not configured to send emails. conf is missing "senderEmail"'
const UPDATE_REQUEST_TTL = 10 * unitToMillis.minute
const DEFAULT_LAUNCH_TEMPLATE_OPTS = {
  template: 'action',
  data: {
    blocks: [
      { body: 'Hi there,' },
      { body: 'Click below to launch your Tradle MyCloud' },
      { body: `Note: You will be shown a form with a field "Stack Name". Don't edit it as it will break your template.` },
      {
        action: {
          text: 'Launch MyCloud',
          href: '{{launchUrl}}'
        }
      }
    ],
    signature: '{{fromOrg.name}} Team',
    // twitter: 'tradles'
  }
}

const DEFAULT_MYCLOUD_ONLINE_TEMPLATE_OPTS = {
  template: 'action',
  data: {
    blocks: [
      { body: ONLINE_MESSAGE },
      { body: 'Use <a href="{{mobile}}">this link</a> to add it to your Tradle mobile app' },
      { body: 'Use <a href="{{web}}">this link</a> to add it to your Tradle web app' },
      { body: 'Give <a href="{{employeeOnboarding}}">this link</a> to employees' },
    ],
    signature: '{{fromOrg.name}} Team',
    // twitter: 'tradles'
  }
}

interface ICreateChildDeploymentOpts {
  configuration: ITradleObject
  deploymentUUID: string
}

interface ITmpTopicResource extends ITradleObject {
  topic: string
}

type StackUpdateTopicInput = {
  topic: string
  stackId: string
}

type CodeLocation = {
  bucket: Bucket
  keys: string[]
}

enum StackOperationType {
  create,
  update
}

// interface IUpdateChildDeploymentOpts {
//   apiUrl?: string
//   deploymentUUID?: string
//   identity?: ResourceStub
//   stackId?: string
// }

interface INotifyCreatorsOpts {
  configuration: ITradleObject
  apiUrl: string
  identity: ResourceStub
}

interface DeploymentCtorOpts {
  bot: Bot
  logger: Logger
  conf?: IDeploymentPluginConf
  orgConf?: IConf
}

const ADMIN_MAPPING_PATH = ['org', 'contact', 'adminEmail']
const ADMIN_EMAIL_ENDPOINT = {
  'Fn::FindInMap': ADMIN_MAPPING_PATH
}

const getDeploymentUUIDFromTemplate = template => _.get(template, 'Mappings.deployment.init.deploymentUUID')
const getServiceNameFromTemplate = template => _.get(template, 'Mappings.deployment.init.service')
const getStageFromTemplate = template => _.get(template, 'Mappings.deployment.init.stage')
const getStackNameFromTemplate = template => _.get(template, 'Mappings.deployment.init.stackName')
const getServiceNameFromDomain = (domain: string) => domain.replace(/[^a-zA-Z0-9]/g, '-')
const getAdminEmailFromTemplate = template => _.get(template, ['Mappings'].concat(ADMIN_MAPPING_PATH))
const normalizeStackName = (name: string) => /^tdl.*?ltd$/.test(name) ? name : `tdl-${name}-ltd`

export class Deployment {
  // exposed for testing
  private bot: Bot
  private env: Env
  private deploymentBucket: Bucket
  private logger: Logger
  private conf?: IDeploymentPluginConf
  private orgConf?: IConf
  constructor({ bot, logger, conf, orgConf }: DeploymentCtorOpts) {
    this.bot = bot
    this.env = bot.env
    this.logger = logger
    this.deploymentBucket = bot.buckets.ServerlessDeployment
    this.conf = conf
    this.orgConf = orgConf
  }

  // const onForm = async ({ bot, user, type, wrapper, currentApplication }) => {
  //   if (type !== CONFIGURATION) return
  //   if (!currentApplication || currentApplication.requestFor !== DEPLOYMENT_PRODUCT) return

  //   const { object } = wrapper.payload
  //   const { domain } = object
  //   try {
  //     await getLogo({ domain })
  //   } catch (err) {
  //     const message = `couldn't process your logo!`
  //     await bot.requestEdit({
  //       user,
  //       item: object,
  //       message,
  //       errors: [
  //         {
  //           name: 'domain',
  //           error: message
  //         }
  //       ]
  //     })
  //   }
  // }

  public genLaunchPackage = async (configuration: IDeploymentConf) => {
    const { stackUtils } = this.bot
    const { region } = configuration
    this.logger.silly('generating cloudformation template with configuration', configuration)
    const [parentTemplate, bucket] = await Promise.all([
      stackUtils.getStackTemplate(),
      this.getDeploymentBucketForRegion(region)
    ])

    const template = await this.customizeTemplateForLaunch({ template: parentTemplate, configuration, bucket })
    const { templateUrl } = await this.saveTemplateAndCode({ parentTemplate: parentTemplate, template, bucket })

    this.logger.debug('generated cloudformation template for child deployment')
    const deploymentUUID = getDeploymentUUIDFromTemplate(template)
    // const promiseTmpTopic = this.setupNotificationsForStack({
    //   id: deploymentUUID,
    //   type: StackOperationType.create
    // })

    const childDeployment = await this.createChildDeployment({ configuration, deploymentUUID })

    // this.logger.debug('generated deployment tracker for child deployment', { uuid })
    return {
      template,
      url: stackUtils.getLaunchStackUrl({
        stackName: getStackNameFromTemplate(template),
        templateUrl,
        region: configuration.region
      }),
      // snsTopic: (await promiseTmpTopic).topic
    }
  }

  public genUpdatePackage = async ({ createdBy, configuredBy, childDeploymentLink, stackId }: {
    childDeploymentLink?: string
    createdBy?: string
    configuredBy?: string
    stackId?: string
  }) => {
    let childDeployment
    if (childDeploymentLink) {
      childDeployment = await this.bot.getResource({
        type: CHILD_DEPLOYMENT,
        link: childDeploymentLink
      })
    } else if (createdBy) {
      childDeployment = await this.getChildDeploymentCreatedBy(createdBy)
    } else if (configuredBy) {
      childDeployment = await this.getChildDeploymentConfiguredBy(configuredBy)
    } else {
      throw new Errors.InvalidInput('expected "createdBy", "configuredBy" or "childDeploymentLink')
    }

    if (!childDeployment) {
      throw new Errors.NotFound('child deployment for stackId: ' + stackId)
    }

    let configuration
    try {
      configuration = await this.bot.getResource(childDeployment.configuration)
    } catch (err) {
      Errors.ignoreNotFound(err)
      throw new Errors.NotFound('original configuration for child deployment not found')
    }

    const result = await this.genUpdatePackageForStack({
      // deployment: childDeployment,
      stackId: stackId || childDeployment.stackId,
      configuration,
    })

    return {
      configuration,
      childDeployment,
      ...result
    }
  }

  public genUpdatePackageForStack = async ({ stackId, configuration }: {
    stackId: string
    configuration?: IDeploymentConf
    // deployment:
  }) => {
    const { region, accountId, name } = this.bot.stackUtils.parseStackArn(stackId)
    const [bucket, parentTemplate] = await Promise.all([
      this.getDeploymentBucketForRegion(region),
      this.bot.stackUtils.getStackTemplate()
    ])

    const template = await this.customizeTemplateForUpdate({ template: parentTemplate, stackId, configuration, bucket })
    const { templateUrl, code } = await this.saveTemplateAndCode({
      parentTemplate,
      template,
      bucket,
    })

    // await code.bucket.grantReadAccess({ keys: code.keys })

    return {
      template,
      url: utils.getUpdateStackUrl({ stackId, templateUrl }),
      snsTopic: (await this.setupNotificationsForStack({
        id: `${accountId}-${name}`,
        type: StackOperationType.update,
        stackId
      })).topic
    }
  }

  public getChildDeploymentCreatedBy = async (createdBy: string): Promise<IDeploymentConf> => {
    return await this.getChildDeployment({
      filter: {
        EQ: {
          'identity._permalink': createdBy
        },
        NULL: {
          stackId: false
        }
      }
    })
  }

  public getChildDeploymentConfiguredBy = async (configuredBy: string): Promise<IDeploymentConf> => {
    return await this.getChildDeployment({
      filter: {
        EQ: {
          'configuredBy._permalink': configuredBy
        },
        NULL: {
          stackId: false
        }
      }
    })
  }

  public getChildDeploymentByStackId = async (stackId: string): Promise<IDeploymentConf> => {
    return await this.getChildDeploymentWithProps({ stackId })
  }

  public getChildDeploymentByDeploymentUUID = async (deploymentUUID: string): Promise<IDeploymentConf> => {
    return await this.getChildDeploymentWithProps({ deploymentUUID })
  }

  public getChildDeploymentWithProps = async (props={}): Promise<IDeploymentConf> => {
    assertNoNullProps(props, `invalid filter props: ${JSON.stringify(props)}`)

    return this.getChildDeployment({
      filter: {
        EQ: props
      }
    })
  }

  public getChildDeployment = async (findOpts={}): Promise<IDeploymentConf> => {
    return await this.bot.db.findOne(_.merge({
      orderBy: {
        property: '_time',
        desc: true
      },
      filter: {
        EQ: {
          [TYPE]: CHILD_DEPLOYMENT
        }
      }
    }, findOpts))
  }

  public getParentDeployment = async (): Promise<ITradleObject> => {
    return await this.bot.db.findOne({
      orderBy: {
        property: '_time',
        desc: true
      },
      filter: {
        EQ: {
          [TYPE]: PARENT_DEPLOYMENT,
          'childIdentity._permalink': await this.bot.getMyPermalink()
        }
      }
    })
  }

  public reportLaunch = async ({ org, identity, referrerUrl, deploymentUUID }: {
    org: IOrganization
    identity: IIdentity
    referrerUrl: string
    deploymentUUID: string
  }) => {
    let saveParentDeployment
    try {
      const friend = await utils.runWithTimeout(
        () => this.bot.friends.load({ url: referrerUrl }),
        { millis: 20000 }
      )

      saveParentDeployment = this.saveParentDeployment({
        friend,
        apiUrl: referrerUrl,
        childIdentity: identity
      })
    } catch (err) {
      this.logger.error('failed to add referring MyCloud as friend', err)
      saveParentDeployment = Promise.resolve()
    }

    const reportLaunchUrl = this.getReportLaunchUrl(referrerUrl)
    const launchData = {
      deploymentUUID,
      apiUrl: this.bot.apiBaseUrl,
      org,
      identity,
      stackId: this.bot.stackUtils.thisStackId
    }

    try {
      await utils.runWithTimeout(() => utils.post(reportLaunchUrl, launchData), { millis: 10000 })
    } catch (err) {
      Errors.rethrow(err, 'developer')
      this.logger.error(`failed to notify referrer at: ${referrerUrl}`, err)
    }

    await saveParentDeployment
  }

  public receiveLaunchReport = async (report: ILaunchReportPayload) => {
    const { deploymentUUID, apiUrl, org, identity, stackId } = report
    let childDeployment
    try {
      childDeployment = await this.getChildDeploymentByDeploymentUUID(deploymentUUID)
    } catch (err) {
      Errors.rethrow(err, 'developer')
      this.logger.error('deployment configuration mapping not found', { apiUrl, deploymentUUID })
      return false
    }

    const friend = await this.bot.friends.add({
      url: apiUrl,
      org,
      identity,
      name: org.name,
      domain: org.domain
    })

    await this.bot.draft({
        type: CHILD_DEPLOYMENT,
        resource: childDeployment
      })
      .set({
        apiUrl,
        identity: friend.identity,
        stackId
      })
      .version()
      .signAndSave()

    return true
  }

  public createChildDeployment = async ({ configuration, deploymentUUID }: ICreateChildDeploymentOpts) => {
    const configuredBy = await this.bot.identities.byPermalink(configuration._author)
    const resource = await this.bot.draft({ type: CHILD_DEPLOYMENT })
      .set({
        configuration,
        configuredBy: utils.omitVirtual(configuredBy),
        deploymentUUID,
      })
      .signAndSave()

    return resource.toJSON()
  }

  public saveParentDeployment = async ({ friend, childIdentity, apiUrl }: {
    friend: ITradleObject
    childIdentity: ITradleObject
    apiUrl: string
  }) => {
    return await this.bot.draft({ type: PARENT_DEPLOYMENT })
      .set({
        childIdentity,
        parentIdentity: friend.identity,
        friend,
        apiUrl
      })
      .signAndSave()
  }

  public notifyConfigurer = async ({ configurer, links }: {
    links: IAppLinkSet
    configurer: string
  }) => {
    const configurerUser = await this.bot.users.get(configurer)

    let message
    if (isEmployee(configurerUser)) {
      const someLinks = _.omit(links, 'employeeOnboarding')
      message = `The MyCloud you drafted has been launched

${this.genUsageInstructions(someLinks)}`
    } else {
      message = `${ONLINE_MESSAGE}

${this.genUsageInstructions(links)}`
    }

    await this.bot.sendSimpleMessage({
      to: configurerUser,
      message
    })
  }

  public notifyCreatorsOfChildDeployment = async (childDeployment) => {
    const { apiUrl, identity } = childDeployment
    const configuration = await this.bot.getResource(childDeployment.configuration)
    // stall till 10000 before time's up
    await this.bot.stall({ buffer: 10000 })
    await this.notifyCreators({ configuration, apiUrl, identity })
  }

  public notifyCreators = async ({ configuration, apiUrl, identity }: INotifyCreatorsOpts) => {
    this.logger.debug('attempting to notify of stack launch')
    const { hrEmail, adminEmail, _author } = configuration as IDeploymentConfForm

    const botPermalink = buildResource.permalink(identity)
    const links = this.getAppLinks({ host: apiUrl, permalink: botPermalink })
    const notifyConfigurer = this.notifyConfigurer({
        configurer: _author,
        links
      })
      .catch(err => {
        this.logger.error('failed to send message to creator', err)
        Errors.rethrow(err, 'developer')
      })

    let emailAdmin
    if (this.conf.senderEmail) {
      emailAdmin = this.bot.mailer.send({
          from: this.conf.senderEmail,
          to: _.uniq([hrEmail, adminEmail]),
          format: 'html',
          ...this.genLaunchedEmail({ ...links, fromOrg: this.orgConf.org })
        })
        .catch(err => {
          this.logger.error('failed to email creators', err)
          Errors.rethrow(err, 'developer')
        })
    } else {
      emailAdmin = Promise.resolve()
      this.logger.debug(NO_SENDER_EMAIL)
    }

    const results = await utils.allSettled([notifyConfigurer, emailAdmin])
    const firstErr = results.find(result => result.reason)
    if (firstErr) throw firstErr
  }

  public getAppLinks = ({ host, permalink }) => getAppLinks({
    bot: this.bot,
    host,
    permalink
  })

  public genLaunchEmailBody = (values) => {
    const renderConf = _.get(this.conf || {}, 'templates.launch') || {}
    const opts = _.defaults(renderConf, DEFAULT_LAUNCH_TEMPLATE_OPTS)
    return this.genEmailBody({ ...opts, values })
  }

  public genLaunchedEmailBody = (values) => {
    const renderConf = _.get(this.conf || {}, 'templates.launched') || {}
    const opts = _.defaults(renderConf, DEFAULT_MYCLOUD_ONLINE_TEMPLATE_OPTS)
    return this.genEmailBody({ ...opts, values })
  }

  public genEmailBody = ({ template, data, values }) => {
    return Templates.email[template](Templates.renderData(data, values))
  }

  public genLaunchEmail = opts => ({
    subject: LAUNCH_MESSAGE,
    body: this.genLaunchEmailBody(opts)
  })

  public genLaunchedEmail = opts => ({
    subject: ONLINE_MESSAGE,
    body: this.genLaunchedEmailBody(opts)
  })

  public genUsageInstructions = getAppLinksInstructions

  public customizeTemplateForLaunch = async ({ template, configuration, bucket }: {
    template: any
    configuration: IDeploymentConf
    bucket: string
  }) => {
    let { name, domain, logo, region, stackPrefix, adminEmail } = configuration

    if (!(name && domain)) {
      throw new Errors.InvalidInput('expected "name" and "domain"')
    }

    const previousServiceName = getServiceNameFromTemplate(template)
    template = _.cloneDeep(template)
    template.Description = `MyCloud, by Tradle`
    domain = normalizeDomain(domain)

    const { Resources, Mappings } = template
    const { org, deployment } = Mappings
    const logoPromise = this.getLogo(configuration)
    const stage = getStageFromTemplate(template)
    const service = normalizeStackName(stackPrefix)
    const dInit: Partial<IMyDeploymentConf> = {
      service,
      stage,
      stackName: this.bot.stackUtils.genStackName({ service, stage }),
      referrerUrl: this.bot.apiBaseUrl,
      deploymentUUID: utils.uuid(),
    }

    deployment.init = dInit
    org.init = {
      name,
      domain,
      logo: await logoPromise || media.LOGO_UNKNOWN
    }

    _.set(Mappings, ADMIN_MAPPING_PATH, adminEmail)
    return this.finalizeCustomTemplate({
      template,
      oldServiceName: previousServiceName,
      newServiceName: service,
      region,
      bucket
    })
  }

  public finalizeCustomTemplate = ({ template, region, bucket, oldServiceName, newServiceName }) => {
    const { stackUtils } = this.bot
    template = stackUtils.changeServiceName({
      template,
      from: oldServiceName,
      to: newServiceName
    })

    template = stackUtils.changeRegion({
      template,
      from: this.env.REGION,
      to: region
    })

    _.forEach(template.Resources, resource => {
      if (resource.Type === 'AWS::Lambda::Function') {
        resource.Properties.Code.S3Bucket = bucket
      }
    })

    return template
  }

  public customizeTemplateForUpdate = async ({ template, stackId, configuration, bucket }: {
    template: any
    stackId: string
    configuration: IDeploymentConf
    bucket: string
  }) => {
    if (!configuration.adminEmail) {
      throw new Errors.InvalidInput('expected "configuration" to have "adminEmail')
    }

    const { service, region } = this.bot.stackUtils.parseStackArn(stackId)
    const previousServiceName = getServiceNameFromTemplate(template)
    template = _.cloneDeep(template)

    // scrap unneeded mappings
    template.Mappings = {}

    const initProps = template.Resources.Initialize.Properties
    Object.keys(initProps).forEach(key => {
      if (key !== 'ServiceToken') {
        delete initProps[key]
      }
    })

    _.set(template.Mappings, ADMIN_MAPPING_PATH, configuration.adminEmail)
    return this.finalizeCustomTemplate({
      template,
      oldServiceName: previousServiceName,
      newServiceName: service,
      region,
      bucket
    })
  }

  public getReportLaunchUrl = (referrerUrl: string = this.bot.apiBaseUrl) => {
    return `${referrerUrl}/deployment-pingback`
  }

  public getLogo = async (opts: { domain: string, logo?: string }): Promise<string | void> => {
    const { domain, logo } = opts
    if (logo) return logo

    try {
      return await Promise.race([
        getFaviconUrl(domain),
        utils.timeoutIn({ millis: 5000 })
      ])
    } catch (err) {
      Errors.rethrow(err, 'developer')
      this.logger.info('failed to get favicon from url', {
        url: domain
      })
    }
  }

  public static encodeRegion = (region: string) => region.replace(/[-]/g, '.')
  public encodeRegion = Deployment.encodeRegion
  public static decodeRegion = (region: string) => region.replace(/[.]/g, '-')
  public decodeRegion = Deployment.decodeRegion

  public parseConfigurationForm = (form: ITradleObject): IDeploymentConf => {
    const region = utils.getEnumValueId({
      model: this.bot.models[AWS_REGION],
      value: form.region
    })

    return <IDeploymentConf>{
      ...form,
      region: this.decodeRegion(region)
    }
  }

  // public createStackStatusTopic = async ({
  //   name: string
  // }) => {
  //   const { thisStackId } = this.bot.stackUtils
  //   this.bot.aws.cloudformation.
  // }

  public setupNotificationsForStack = async ({ id, type, stackId }: {
    id: string
    type: StackOperationType
    stackId: string
  }) => {
    const name = getTmpSNSTopicName({ id, type })
    const { topic } = await this.genTmpSNSTopic({ topic: name, stackId })
    return await this.subscribeToChildStackStatusNotifications(topic)
  }

  public genTmpSNSTopic = async ({ topic, stackId }: StackUpdateTopicInput): Promise<ITmpTopicResource> => {
    const arn = await this.createStackUpdateTopic({ topic, stackId })
    try {
      await this._refreshTmpSNSTopic(arn)
    } catch (err) {
      Errors.ignoreNotFound(err)
    }

    return await this.bot.signAndSave({
      [TYPE]: TMP_SNS_TOPIC,
      topic: arn,
      dateExpires: getTmpTopicExpirationDate()
    })
  }

  public deleteTmpSNSTopic = async (topic: string) => {
    const shortName = topic.split(/[/:]/).pop()
    if (!shortName.startsWith('tmp-')) {
      throw new Errors.InvalidInput(`expected tmp topic, got: ${topic}`)
    }

    this.logger.debug('unscribing, deleting tmp topic', { topic })
    await this.unsubscribeFromTopic(topic)
    await this.deleteTopic(topic)
  }

  public deleteTopic = async (topic: string) => {
    this._regionalSNS(topic).deleteTopic({ TopicArn: topic }).promise()
  }

  public deleteExpiredTmpTopics = async () => {
    const topics = await this.getExpiredTmpSNSTopics()
    if (!topics.length) return []

    await Promise.all(topics.map(topic => this.bot.db.del(topic)))
    return topics
  }

  public getRecentlyExpiredTmpSNSTopics = async () => {
    return this.getTmpSNSTopics({
      GT: {
        dateExpires: Date.now() - TMP_SNS_TOPIC_TTL
      },
      LT: {
        dateExpires: Date.now()
      }
    })
  }

  public getExpiredTmpSNSTopics = async () => {
    return this.getTmpSNSTopics({
      LT: {
        dateExpires: Date.now()
      }
    })
  }

  public getTmpSNSTopics = async (filter = {}) => {
    const { items } = await this.bot.db.find({
      orderBy: {
        property: 'dateExpires',
        desc: false
      },
      filter: _.merge({
        EQ: {
          [TYPE]: TMP_SNS_TOPIC
        }
      }, filter)
    })

    return items
  }

  public subscribeToChildStackStatusNotifications = async (topic: string) => {
    // TODO: this crap belongs in some aws utils module
    const lambdaArn = this._getLambdaArn('onChildStackStatusChanged')
    this.logger.debug('subscribing lambda to SNS topic', {
      topic,
      lambda: lambdaArn
    })

    const promiseSubscribe = this.subscribeLambdaToTopic({ topic, lambda: lambdaArn })
    const promisePermission = this.bot.aws.lambda.addPermission({
      StatementId: 'allowTopicTrigger' + randomStringWithLength(10),
      Action: 'lambda:InvokeFunction',
      Principal: 'sns.amazonaws.com',
      SourceArn: topic,
      FunctionName: lambdaArn
    }).promise()

    const { SubscriptionArn } = await promiseSubscribe
    await promisePermission
    return {
      topic,
      subscription: SubscriptionArn,
    }
  }

  public subscribeLambdaToTopic = async ({ lambda, topic }) => {
    const params:AWS.SNS.SubscribeInput = {
      TopicArn: topic,
      Protocol: 'lambda',
      Endpoint: lambda,
    }

    return await this._regionalSNS(topic).subscribe(params).promise()
  }

  public setChildStackStatus = async ({ stackId, status, subscriptionArn }: StackStatus) => {
    const childDeployment = await this.getChildDeploymentByStackId(stackId)
    if (childDeployment.status === status) {
      this.logger.debug('ignoring duplicate child stack status update', {
        status,
        childDeployment: childDeployment._permalink
      })

      return childDeployment
    }

    this.logger.debug('updating child deployment status', {
      status,
      childDeployment: childDeployment._permalink
    })

    const updated = await this.bot.draft({ resource: childDeployment })
      .set({ status })
      .version()
      .signAndSave()

    if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') {
      await this.unsubscribeFromTopic(subscriptionArn)
    }

    return updated
  }

  public unsubscribeFromTopic = async (SubscriptionArn: string) => {
    await this._regionalSNS(SubscriptionArn).unsubscribe({ SubscriptionArn }).promise()
  }

  public getDeploymentBucketForRegion = async (region: string) => {
    if (region === this.env.REGION) {
      return this.deploymentBucket.id
    }

    try {
      return await this.bot.s3Utils.getRegionalBucketForBucket({
        bucket: this.deploymentBucket.id,
        region
      })
    } catch (err) {
      Errors.ignoreNotFound(err)
      throw new Errors.InvalidInput(`unsupported region: ${region}`)
    }
  }

  public savePublicTemplate = async ({ template, bucket }: {
    template: any
    bucket: string
  }) => {
    const key = `templates/template-${Date.now()}-${randomStringWithLength(12)}.json`
    await this._bucket(bucket).putJSON(key, template, { acl: 'public-read' })
    return this.bot.s3Utils.getUrlForKey({ bucket, key })
  }

  public copyLambdaCode = async ({ template, bucket }: {
    template: any
    bucket: string
  }) => {
    let keys:string[] = _.uniq(
      this.bot.stackUtils.getLambdaS3Keys(template).map(k => k.value)
    )

    const source = this.bot.buckets.ServerlessDeployment
    if (bucket === source.id) {
      return
    }

    const target = this._bucket(bucket)
    const exists = await Promise.all(keys.map(key => target.exists(key)))
    keys = keys.filter((key, i) => !exists[i])

    if (!keys.length) {
      this.logger.debug('target bucket already has lambda code')
      return
    }

    this.logger.debug('copying lambda code', {
      source: source.id,
      target: target.id
    })

    await source.copyFilesTo({ bucket, keys, acl: 'public-read' })
    return { bucket: target, keys }
  }

  public saveTemplateAndCode = async ({ parentTemplate, template, bucket }: {
    parentTemplate: any
    template: any
    bucket: string
  }):Promise<{ url: string, code: CodeLocation }> => {
    this.logger.debug('saving template and lambda code', { bucket })
    const [templateUrl, code] = await Promise.all([
      this.savePublicTemplate({ bucket, template }),
      this.copyLambdaCode({ bucket, template: parentTemplate })
    ])

    return { templateUrl, code }
  }

  public createRegionalDeploymentBuckets = async ({ regions }: {
    regions: string[]
  }) => {
    this.logger.debug('creating regional buckets', { regions })
    return await this.bot.s3Utils.createRegionalBuckets({
      bucket: this.bot.buckets.ServerlessDeployment.id,
      regions
    })
  }

  public deleteRegionalDeploymentBuckets = async ({ regions }: {
    regions: string[]
  }) => {
    return await this.bot.s3Utils.deleteRegionalBuckets({
      bucket: this.bot.buckets.ServerlessDeployment.id,
      regions,
      iam: this.bot.aws.iam
    })
  }

  public updateOwnStack = async ({ templateUrl, notificationTopics = [] }: {
    templateUrl: string
    notificationTopics?: string[]
  }) => {
    await this.bot.lambdaUtils.invoke({
      name: 'updateStack',
      arg: { templateUrl, notificationTopics },
    })
  }

  public requestUpdate = async () => {
    const parent = await this.getParentDeployment()
    return this.requestUpdateFromParent(parent)
  }

  public requestUpdateFromParent = async (parent: ITradleObject) => {
    const updateReq = this.createUpdateRequestResource(parent)
    await this.bot.send({
      to: parent.parentIdentity._permalink,
      object: updateReq
    })
  }

  public createUpdateRequestResource = (parent: ITradleObject) => {
    if (parent[TYPE] !== PARENT_DEPLOYMENT) {
      throw new Errors.InvalidInput(`expected "parent" to be tradle.MyCloudFriend`)
    }

    const { parentIdentity } = parent
    const { env } = this.bot
    return this.bot.draft({ type: UPDATE_REQUEST })
      .set({
        service: env.SERVERLESS_SERVICE_NAME,
        stage: env.SERVERLESS_STAGE,
        region: env.AWS_REGION,
        provider: parentIdentity,
      })
      .toJSON()
  }

  public handleUpdateRequest = async ({ req, from }: {
    req: ITradleObject
    from: ITradleObject
  }) => {
    if (req._author !== buildResource.permalink(from)) {
      throw new Errors.InvalidAuthor(`expected update request author to be the same identity as "from"`)
    }

    if (req.currentCommit === this.bot.version.commit) {
      this.logger.debug('child is up to date')
      throw new Errors.Exists(`already up to date`)
    }

    const pkg = await this.genUpdatePackage({
      createdBy: req._author
    })

    const { snsTopic, url } = pkg
    const resp = await this.bot.draft({ type: UPDATE_RESPONSE })
      .set({
        templateUrl: url,
        notificationTopics: snsTopic,
        request: req,
        provider: from
      })
      .sign()

    await this.bot.send({
      to: req._author,
      object: resp.toJSON()
    })

    return pkg
  }

  public handleUpdateResponse = async (updateResponse: ITradleObject) => {
    await this._validateUpdateResponse(updateResponse)
    const { templateUrl, notificationTopics } = updateResponse
    await this.updateOwnStack({
      templateUrl,
      notificationTopics: notificationTopics.split(',').map(s => s.trim())
    })
  }

  public lookupUpdateRequest = async (providerPermalink: string) => {
    if (!(typeof providerPermalink === 'string' && providerPermalink)) {
      throw new Errors.InvalidInput('expected provider permalink')
    }

    return await this.bot.db.findOne({
      orderBy: {
        property: '_time',
        desc: true
      },
      filter: {
        EQ: {
          [TYPE]: UPDATE_REQUEST,
          'provider._permalink': providerPermalink
        }
      }
    })
  }

  private _getLambdaArn = (lambdaShortName: string) => {
    const { env } = this.bot
    const lambdaName = env.getStackResourceName(lambdaShortName)
    return `arn:aws:lambda:${env.AWS_REGION}:${env.AWS_ACCOUNT_ID}:function:${lambdaName}`
  }

  public createStackUpdateTopic = async ({ topic, stackId }: StackUpdateTopicInput) => {
    const createParams:AWS.SNS.CreateTopicInput = { Name: topic }
    const sns = this._regionalSNS(stackId)
    const { TopicArn } = await sns.createTopic(createParams).promise()
    const allowParams:AWS.SNS.AddPermissionInput = {
      TopicArn,
      ActionName: ['Publish'],
      AWSAccountId: getUpdateStackAssumedRoles(stackId),
      Label: genSID('allowCrossAccountPublish'),
    }

    await sns.addPermission(allowParams).promise()
    return TopicArn
  }

  private _bucket = (name: string) => {
    const { bot } = this
    return new Bucket({
      name,
      env: bot.env,
      s3: bot.aws.s3,
      s3Utils: bot.s3Utils,
      logger: bot.logger
    })
  }

  private _validateUpdateResponse = async (updateResponse: ITradleObject) => {
    const provider = updateResponse._author

    let req: ITradleObject
    try {
      req = await this.lookupUpdateRequest(provider)
    } catch (err) {
      Errors.ignoreNotFound(err)
      this.logger.warn('received stack update response...but no request was made, ignoring', {
        from: provider,
        updateResponse: this.bot.buildStub(updateResponse)
      })

      throw err
    }

    if (req._time + UPDATE_REQUEST_TTL < Date.now()) {
      const msg = 'received update response for expired request, ignoring'
      this.logger.warn(msg, {
        from: provider,
        updateResponse: this.bot.buildStub(updateResponse)
      })

      throw new Errors.Expired(msg)
    }
  }

  private _refreshTmpSNSTopic = async (arn: string) => {
    const existing = await this.bot.db.findOne({
      filter: {
        EQ: {
          [TYPE]: TMP_SNS_TOPIC,
          topic: arn
        }
      }
    })

    const updated = await this.bot.draft({ resource: existing })
      .set({
        dateExpires: getTmpTopicExpirationDate()
      })
      .version()
      .signAndSave()

    return updated.toJSON()
  }

  private _regionalSNS = (arn: string) => {
    const region = getArnRegion(arn)
    const { regional } = this.bot.aws
    const services = regional[region]
    return services.sns
  }
}

const UPDATE_STACK_LAMBDAS = [
  'updateStack'
]

const getArnRegion = (arn: string) => utils.parseArn(arn).region

export const getUpdateStackAssumedRoles = (stackId: string, lambdas=UPDATE_STACK_LAMBDAS) => {
  // maybe make a separate lambda for this (e.g. update-stack)
  const {
    accountId,
    name,
    region,
  } = StackUtils.parseStackArn(stackId)

  return lambdas.map(
    lambdaName => `arn:aws:sts::${accountId}:assumed-role/${name}-${region}-updateStackRole/${name}-${lambdaName}`
  )
}

export const createDeployment = (opts:DeploymentCtorOpts) => new Deployment(opts)

const scaleTable = ({ table, scale }) => {
  let { ProvisionedThroughput } = table.Properties
  ProvisionedThroughput.ReadCapacityUnits *= scale
  ProvisionedThroughput.WriteCapacityUnits *= scale
  const { GlobalSecondaryIndexes=[] } = table
  GlobalSecondaryIndexes.forEach(index => scaleTable({ table: index, scale }))
}

const isValidDomain = domain => {
  return domain.includes('.') && /^(?:[a-zA-Z0-9-_.]+)$/.test(domain)
}

const normalizeDomain = (domain:string) => {
  domain = domain.replace(/^(?:https?:\/\/)?(?:www\.)?/, '')
  if (!isValidDomain(domain)) {
    throw new Errors.InvalidInput('invalid domain')
  }

  return domain
}

const getTmpSNSTopicName = ({ id, type }: {
  id: string
  type: StackOperationType
}) => {
  const verb = type === StackOperationType.create ? 'create' : 'update'
  return `tmp-${verb}-${id}` //-${randomStringWithLength(10)}`
}

const genSID = (base: string) => `${base}${randomStringWithLength(10)}`

const getTmpTopicExpirationDate = () => Date.now() + TMP_SNS_TOPIC_TTL

const assertNoNullProps = (obj: any, msg: string) => {
  for (let p in obj) {
    if (obj[p] == null) {
      throw new Errors.InvalidInput(msg)
    }
  }
}
