const fs = require('fs');
const path = require('path');
const BbPromise = require('bluebird');
const ymlPath = path.resolve(__dirname, '../serverless.yml');
const getServerlessConfigFile = () => {
  const file = fs.readFileSync(ymlPath, { encoding: 'utf8' });
  return BbPromise.resolve(YAML.load(file));
}

const YAML = require('js-yaml');

class Print {
  constructor(serverless) {
    this.serverless = serverless;

    this.commands = {
      print: {
        usage: 'Print your compiled and resolved config file',
        lifecycleEvents: [
          'print',
        ],
      },
    };
    this.hooks = {
      'print:print': () => BbPromise.bind(this)
        .then(this.print),
    };
  }

  print() {
    this.serverless.variables.options = this.serverless.processedInput.options;
    this.serverless.variables.loadVariableSyntax();
    return getServerlessConfigFile(process.cwd())
      .then((data) => {
        const conf = data;
        // Need to delete variableSyntax to avoid potential matching errors
        if (conf.provider.variableSyntax) {
          delete conf.provider.variableSyntax;
        }
        return conf;
      })
      .then((data) => this.serverless.variables.populateObject(data))
      .then((data) => this.serverless.cli.consoleLog(YAML.dump(data)));
  }

}

module.exports = Print;
