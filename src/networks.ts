
const curve = 'secp256k1'
const constants = {
  bitcoin: {
    testnet: {
      minBalance: 1000000,
      confirmations: 6
    },
    // bitcoinjs-lib's name for it
    bitcoin: {
      minBalance: 1000000,
      confirmations: 6
    }
  },
  ethereum: {
    mainnet: {
      minBalance: '2000000000000000000',
      confirmations: 12
    },
    ropsten: {
      minBalance: '2000000000000000000',
      confirmations: 12
    },
    rinkeby: {
      minBalance: '2000000000000000000',
      confirmations: 12
    }
  },
  corda: {
    private: {
      confirmations: 0
    }
  }
}

const networks = {}

const getAdapter = name => {
  const adapters = require('./blockchain-adapter').default
  return adapters[name]
}

Object.keys(constants).forEach(flavor => {
  const sub = networks[flavor] = {}
  Object.keys(constants[flavor]).forEach(networkName => {
    let readOnlyAdapter
    let cached
    Object.defineProperty(sub, networkName, {
      enumerable: true,
      get() {
        if (!cached) {
          cached = {
            ...constants[flavor][networkName],
            flavor,
            networkName,
            curve,
            get constants () {
              if (!readOnlyAdapter) {
                readOnlyAdapter = getReadOnlyAdapter()
              }

              return readOnlyAdapter.constants
            },
            readOnlyAdapter: getReadOnlyAdapter,
            transactor: function (privateKey) {
              return getAdapter(flavor)({ networkName, privateKey }).transactor
            },
            toString: () => `${flavor}:${networkName}`,
            select: obj => obj[flavor]
          }
        }

        return cached
      }
    })

    function getReadOnlyAdapter (opts:any={}) {
      if (!readOnlyAdapter) {
        opts.networkName = networkName
        readOnlyAdapter = getAdapter(flavor)(opts)
      }

      return readOnlyAdapter
    }
  })
})

export = networks
