import querystring from 'querystring'
import _ from 'lodash'
// @ts-ignore
import Promise from 'bluebird'
import { Lambda } from 'aws-sdk'
import {
  Env,
  Logger,
  AwsApis,
  LambdaUtils,
  Bucket,
  ILaunchStackUrlOpts,
  IUpdateStackUrlOpts,
  VersionInfo,
} from './types'

import Errors from './errors'
import * as utils from './utils'
import { randomString } from './crypto'
import {
  LAUNCH_STACK_BASE_URL
} from './constants'

import { genOptionsBlock } from './gen-cors-options-block'
import { RetryableTask } from './retryable-task'

// const version = require('./version') as VersionInfo

type StackInfo = {
  arn: string
  name: string
  region: string
}

const X_INTEGRATION = 'x-amazon-apigateway-integration'
const ALLOW_HEADERS = 'method.response.header.Access-Control-Allow-Headers'
const METHODS = [
  'GET',
  'HEAD',
  'DELETE',
  'POST',
  'PUT',
  'PATCH'
]

const stripDashes = str => str.replace(/[-]/g, '')

type StackUtilsOpts = {
  aws: AwsApis
  env: Env
  stackArn: string
  apiId: string
  logger?: Logger
  lambdaUtils: LambdaUtils
  deploymentBucket: Bucket
}

export default class StackUtils {
  private aws?: AwsApis
  private env: Env
  private logger: Logger
  private lambdaUtils: LambdaUtils
  private apiId: string
  private deploymentBucket: Bucket
  public thisStack: StackInfo

  constructor({ aws, env, logger, lambdaUtils, stackArn, apiId, deploymentBucket }: StackUtilsOpts) {
    this.aws = aws
    this.env = env
    this.logger = logger
    this.lambdaUtils = lambdaUtils
    this.deploymentBucket = deploymentBucket

    const { arn, name } = StackUtils.parseStackArn(stackArn)
    this.thisStack = {
      arn,
      name,
      region: env.AWS_REGION
    }

    this.apiId = apiId
  }

  public get thisStackId () { return this.thisStack.arn }
  public get thisStackArn () { return this.thisStack.arn }
  public get thisStackName () { return this.thisStack.name }

  public static resolveMappings = (serverlessYml) => {
    serverlessYml = _.cloneDeep(serverlessYml)
    const { resources } = serverlessYml
    const { Mappings } = resources
    const updates = []
    utils.traverse(resources).forEach(function (value) {
      if (this.key === 'Fn::FindInMap') {
        updates.push({
          path: this.path.slice(0, -1),
          value: _.get(Mappings, value)
        })
      }
    })

    updates.forEach(({ path, value }) => _.set(resources, path, value))
    return serverlessYml
  }

  public resolveMappings = StackUtils.resolveMappings

  public static get serverlessYml() { return require('./cli/serverless-yml') }
  public static get serverlessYmlWithResolvedMappings() {
    return StackUtils.resolveMappings(StackUtils.serverlessYml)
  }

  public get serverlessYml() { return StackUtils.serverlessYml }
  public get serverlessYmlWithResolvedMappings() { return StackUtils.serverlessYmlWithResolvedMappings }

  public static parseStackName = (name: string) => {
    const [service, stage] = name.match(/^(.*?)-([^-]+)$/).slice(1)
    return { service, stage }
  }

  public static parseStackArn = (arn: string) => {
    const parsed = utils.parseArn(arn)
    const name = parsed.id.split('/')[0]
    const { service, stage } = StackUtils.parseStackName(name)
    return {
      ...parsed,
      name,
      service,
      stage,
      arn
    }
  }

  public parseStackArn = StackUtils.parseStackArn
  public parseStackName = StackUtils.parseStackName

  public listStacks = async ():Promise<AWS.CloudFormation.StackSummaries> => {
    let stacks = []
    const opts:AWS.CloudFormation.ListStacksInput = {}
    while (true) {
      let {
        StackSummaries,
        NextToken
      } = await this.aws.cloudformation.listStacks().promise()

      stacks = stacks.concat(StackSummaries)
      if (!NextToken) break
    }

    return stacks
  }

  public getLaunchStackUrl = (opts: Partial<ILaunchStackUrlOpts>) => {
    const { templateUrl, ...rest } = opts
    if (!templateUrl) throw new Errors.InvalidInput('expected "templateUrl"')

    return utils.getLaunchStackUrl({
      region: this.env.AWS_REGION,
      stackName: this.thisStackName,
      templateUrl,
      ...rest
    })
  }

  public getUpdateStackUrl = async ({
    region=this.env.AWS_REGION,
    stackName=this.thisStackName,
    stackId=this.thisStackId,
    templateUrl
  }: IUpdateStackUrlOpts) => {
    if (!stackId) {
      const stacks = await this.listStacks()
      const stack = stacks.find(({ StackName }) => StackName === stackName)
      if (!stack) {
        throw new Errors.NotFound(`stack with name: ${stackName}`)
      }

      stackId = stack.StackId
    }

    return utils.getUpdateStackUrl({ stackId, templateUrl })
  }

  public static genStackName = ({ service, stage }: {
    service: string
    stage: string
  }) => {
    if (!(service && stage)) throw new Error('expected "service" and "stage"')

    return `${service}-${stage}`
  }

  public genStackName = StackUtils.genStackName

  public getStackResources = async (StackName: string=this.thisStack.name):Promise<AWS.CloudFormation.StackResourceSummaries> => {
    let resources = []
    const opts:AWS.CloudFormation.ListStackResourcesInput = { StackName }
    while (true) {
      let {
        StackResourceSummaries,
        NextToken
      } = await this.aws.cloudformation.listStackResources(opts).promise()

      resources = resources.concat(StackResourceSummaries)
      opts.NextToken = NextToken
      if (!opts.NextToken) break
    }

    return resources
  }

  public getCurrentAdminEmail = async () => {
    const resources = await this.getStackResources()
    const { PhysicalResourceId } = resources.find(r => {
      return r.ResourceType === 'AWS::SNS::Topic' && r.LogicalResourceId === 'AwsAlertsAlarm'
    })

    const { Subscriptions } = await this.aws.sns.listSubscriptionsByTopic({
      TopicArn: PhysicalResourceId
    }).promise()

    const emails = Subscriptions.filter(s => s.Protocol === 'email')
    return emails[0].Endpoint
  }

  public updateEnvironments = async(map:(conf:Lambda.Types.FunctionConfiguration) => any) => {
    if (this.env.TESTING) {
      this.logger.debug(`updateEnvironments is skipped in test mode`)
      return
    }

    const functions = await this.getStackFunctionConfigurations()
    if (!functions) return

    const writes = functions.map(current => {
      const update = map(current)
      return update && {
        current,
        update
      }
    })
    .filter(_.identity)
    .map(this.updateEnvironment)

    await Promise.all(writes)
  }

  public updateEnvironment = async (opts: {
    functionName?: string,
    current?: any,
    update: any
  }) => {
    if (this.env.TESTING) {
      this.logger.debug(`updateEnvironment is skipped in test mode`)
      return
    }

    let { functionName, update } = opts
    let { current } = opts
    if (!current) {
      if (!functionName) throw new Error('expected "functionName"')

      current = await this.lambdaUtils.getConfiguration(functionName)
    }

    functionName = current.FunctionName
    const updated = {}
    const { Variables } = current.Environment
    for (let key in update) {
      // allow null == undefined
      if (Variables[key] != update[key]) {
        updated[key] = update[key]
      }
    }

    if (!Object.keys(updated).length) {
      this.logger.debug(`not updating "${functionName}", no new environment variables`)
      return
    }

    for (let key in updated) {
      let val = updated[key]
      if (val == null) {
        delete Variables[key]
      } else {
        Variables[key] = val
      }
    }

    this.logger.debug(`updating "${functionName}" with new environment variables`, Variables)
    await this.aws.lambda.updateFunctionConfiguration({
      FunctionName: functionName,
      Environment: { Variables }
    }).promise()
  }

  public forceReinitializeContainers = async (functions?:string[]) => {
    await this.updateEnvironments(({ FunctionName }) => {
      if (!functions || functions.includes(FunctionName)) {
        this.logger.debug(`reinitializing container for lambda: ${FunctionName}`)
        return getDateUpdatedEnvironmentVariables()
      }

      this.logger.debug(`not reinitializing container for lambda: ${FunctionName}`)
    })
  }

  public forceReinitializeContainer = async (functionName:string) => {
    this.logger.debug(`reinitializing container for lambda: ${functionName}`)
    await this.updateEnvironment({
      functionName,
      update: getDateUpdatedEnvironmentVariables()
    })
  }

  public listFunctions = async (StackName:string=this.thisStack.name):Promise<Lambda.Types.FunctionConfiguration[]> => {
    let all = []
    let Marker
    let opts:Lambda.Types.ListFunctionsRequest = {}
    while (true) {
      let { NextMarker, Functions } = await this.aws.lambda.listFunctions(opts).promise()
      all = all.concat(Functions)
      if (!NextMarker) break

      opts.Marker = NextMarker
    }

    return all
  }

  public listStackFunctions = async (StackName?:string)
    :Promise<string[]> => {
    const resources = await this.getStackResources(StackName)
    const lambdaNames:string[] = []
    for (const { ResourceType, PhysicalResourceId } of resources) {
      if (ResourceType === 'AWS::Lambda::Function' && PhysicalResourceId) {
        lambdaNames.push(PhysicalResourceId)
      }
    }

    return lambdaNames
  }

  // public getStackFunctionConfigurations = async (StackName?:string)
  //   :Promise<Lambda.Types.FunctionConfiguration[]> => {
  //   const names = await this.listStackFunctions()
  //   return Promise.all(names.map(name => this.getConfiguration(name)))
  // }

  public getStackFunctionConfigurations = async (StackName?:string)
    :Promise<Lambda.Types.FunctionConfiguration[]> => {
    const [names, configs] = await Promise.all([
      this.listStackFunctions(),
      this.listFunctions()
    ])

    return configs.filter(({ FunctionName }) => names.includes(FunctionName))
  }

  public getStackTemplateForVersion = async (version: VersionInfo) => {
    const { templateKey } = this.getStackLocation(version)
    return this.deploymentBucket.getJSON(templateKey)
  }

  public getStackTemplate = async () => {
    if (this.env.TESTING) {
      return _.cloneDeep(require('./cli/cloudformation-template.json'))
    }

    const { TemplateBody } = await this.aws.cloudformation
      .getTemplate({ StackName: this.thisStack.name })
      .promise()

    return JSON.parse(TemplateBody)
  }

  public enableBinaryAPIResponses = async () => {
    const swagger = await this.getSwagger()
    return await this.addBinarySupportToSwagger(swagger)
  }

  public getSwagger = async () => {
    if (this.env.TESTING) {
      return {}
    }

    const { body } = await this.aws.apigateway.getExport({
      restApiId: this.apiId,
      exportType: 'swagger',
      accepts: 'application/json',
      parameters: {
        extensions: 'integrations'
      },
      stageName: this.env.STAGE
    })
    .promise()

    return JSON.parse(body.toString())
  }

  public addBinarySupportToSwagger = async (swagger):Promise<boolean> => {
    if (this.env.TESTING) {
      return false
    }

    const original = _.cloneDeep(swagger)
    this.logger.debug('setting binary mime types')
    swagger['x-amazon-apigateway-binary-media-types'] = ['*/*']
    for (let path in swagger.paths) {
      let pathConf = swagger.paths[path]
      // TODO: check methods against serverless.yml
      let methods = METHODS
      let defaultOptionsBlock = genOptionsBlock({ methods })
      if (pathConf.options) {
        this.logger.debug(`updating existing OPTIONS integration for path: ${path}`)
        let integrationOpts = pathConf.options[X_INTEGRATION]
        if (integrationOpts) {
          if (!integrationOpts.contentHandling) {
            // THE SKELETON KEY
            integrationOpts.contentHandling = 'CONVERT_TO_TEXT'
          }

          integrationOpts.responses.default.responseParameters[ALLOW_HEADERS]
            = defaultOptionsBlock[X_INTEGRATION].responses.default.responseParameters[ALLOW_HEADERS]
        } else {
          pathConf.options[X_INTEGRATION] = defaultOptionsBlock[X_INTEGRATION]
        }
      } else {
        this.logger.debug(`setting default OPTIONS integration for path ${path}`)
        pathConf.options = defaultOptionsBlock
      }
    }

    if (_.isEqual(original, swagger)) {
      this.logger.debug('skipping update, remote swagger is already up to date')
      return false
    }

    await this.pushSwagger(swagger)
    return true
  }

  public pushSwagger = async (swagger) => {
    await this.aws.apigateway.putRestApi({
      restApiId: this.apiId,
      mode: 'merge',
      body: JSON.stringify(swagger)
    }).promise()

    await this.createDeployment()
  }

  public static changeServiceName = ({ template, from, to }) => {
    if (!(template && from && to)) {
      throw new Error('expected "template", "from", and "to"')
    }

    const s3Keys = StackUtils.getLambdaS3Keys(template)
    const fromRegex = new RegExp(from, 'g')
    const fromNoDashRegex = new RegExp(stripDashes(from), 'g')
    const toRegex = new RegExp(to, 'g')
    const resultStr = JSON.stringify(template)
      .replace(fromRegex, to)
      .replace(fromNoDashRegex, stripDashes(to))

    const result = JSON.parse(resultStr)
    s3Keys.forEach(({ path, value }) => _.set(result, path, value))
    return result
  }

  public static getLambdaS3Keys = (template: any) => {
    const keys = []
    const { Resources } = template
    for (let name in Resources) {
      let value = Resources[name]
      if (value.Type === 'AWS::Lambda::Function') {
        keys.push({
          path: `Resources['${name}'].Properties.Code.S3Key`,
          value: value.Properties.Code.S3Key
        })
      }
    }

    return keys
  }

  public static changeRegion = ({ template, from, to }) => {
    const toChange = _.omit(template, 'Mappings')
    const str = JSON.stringify(toChange)
      .replace(new RegExp(from, 'ig'), to)
      .replace(new RegExp(normalizePathPart(from), 'g'), normalizePathPart(to))

    return {
      ...JSON.parse(str),
      Mappings: template.Mappings
    }
  }

  // public static changeAdminEmail = ({ template, to }) => {
  //   return {
  //     ...template,
  //     Resources: _.transform(<any>template.Resources, (updated:any, value:any, logicalId:string) => {
  //       const { Type } = value
  //       if (Type === 'AWS::SNS::Topic' && logicalId.toLowerCase().endsWith('alarm')) {
  //         value = _.cloneDeep(value)
  //         const { Subscription = [] } = value.Properties
  //         Subscription.forEach(item => {
  //           if (item.Protocol === 'email') item.Endpoint = to
  //         })
  //       }

  //       updated[logicalId] = value
  //     }, {})
  //   }
  // }

  public changeServiceName = StackUtils.changeServiceName
  public changeRegion = StackUtils.changeRegion
  public getLambdaS3Keys = StackUtils.getLambdaS3Keys

  public updateStack = async ({ templateUrl, notificationTopics = [] }: {
    templateUrl: string
    notificationTopics: string[]
  }) => {
    const params: AWS.CloudFormation.UpdateStackInput = {
      StackName: this.thisStackArn,
      TemplateURL: templateUrl,
      Capabilities: [
        'CAPABILITY_IAM',
        'CAPABILITY_NAMED_IAM'
      ],
      Parameters: [],
      NotificationARNs: notificationTopics,
    }

    this.logger.info('updating this stack')
    return this.aws.cloudformation.updateStack(params).promise()
  }

  public static getStackLocationKeys = ({ service, stage, region, versionInfo }:  {
    service: string
    stage: string
    region: string
    versionInfo: VersionInfo
  }) => {
    const { tag, commit } = versionInfo
    const dir = `serverless/${service}/${stage}/${tag}/${commit}`
    const templateKey = `${dir}/compiled-cloudformation-template.json`
    const zipKey = `${dir}/${service}.zip`
    return {
      dir,
      templateKey,
      zipKey
    }
  }

  public static getStackLocation = (opts: {
    service: string
    stage: string
    region: string
    versionInfo: VersionInfo
    deploymentBucket?: Bucket
  }) => {
    const { region, deploymentBucket } = opts
    const regional = deploymentBucket.getRegionalBucket(region)
    const loc = StackUtils.getStackLocation(opts)
    const { zipKey, templateKey } = loc
    return {
      ...loc,
      templateUrl: regional.getUrlForKey(templateKey),
      zipUrl: regional.getUrlForKey(zipKey),
    }
  }

  public getStackLocation = (versionInfo: VersionInfo) => StackUtils.getStackLocation({
    service: this.env.SERVERLESS_SERVICE_NAME,
    stage: this.env.SERVERLESS_STAGE,
    region: this.env.AWS_REGION,
    versionInfo,
    deploymentBucket: this.deploymentBucket
  })

  // public changeAdminEmail = StackUtils.changeAdminEmail
  private createDeployment = async () => {
    await this.aws.apigateway.createDeployment({
      restApiId: this.apiId,
      stageName: this.env.STAGE
    }).promise()
  }
}

export { StackUtils }
export const create = opts => new StackUtils(opts)

const getDateUpdatedEnvironmentVariables = () => ({
  DATE_UPDATED: String(Date.now())
})

// copied from serverless/lib/plugins/aws/lib/naming.js
const normalizePathPart = path => _.upperFirst(
  _.capitalize(path)
    .replace(/-/g, 'Dash')
    .replace(/\{(.*)\}/g, '$1Var')
    .replace(/[^0-9A-Za-z]/g, '')
)
