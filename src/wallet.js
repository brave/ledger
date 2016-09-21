var braveHapi = require('./brave-hapi')
var debug = new (require('sdebug'))('wallet')
var Joi = require('joi')
var underscore = require('underscore')

var Wallet = function (config) {
  if (!(this instanceof Wallet)) return new Wallet(config)

  if (!config.wallet) throw new Error('config.wallet undefined')

  if (!config.wallet.bitgo) config.wallet = { bitgo: config.wallet }
  this.config = config.wallet
  this.config.environment = config.wallet.bitgo.environment
  this.bitgo = new (require('bitgo')).BitGo({ accessToken: config.wallet.bitgo.accessToken,
                                              env: config.wallet.bitgo.environment || 'prod' })
  debug('environment: ' + this.config.environment)
}

Wallet.prototype.create = async function (prefix, label, keychains) {
  var result
  var xpubs = []

  xpubs[0] = underscore.pick(await this.bitgo.keychains().add(underscore.extend({ label: 'user' }, keychains.user)), [ 'xpub' ])
  xpubs[1] = underscore.pick(await this.bitgo.keychains().add({ label: 'unspendable',
                                                                xpub: this.config.bitgo.unspendableXpub }), [ 'xpub' ])
  xpubs[2] = underscore.pick(await this.bitgo.keychains().createBitGo({}), [ 'xpub' ])

  result = await this.bitgo.wallets().add({ label: label,
                                            m: 2,
                                            n: 3,
                                            keychains: xpubs,
                                            enterprise: this.config.bitgo.enterpriseId,
                                            disableTransactionNotifications: true
                                          })
  result.wallet.provider = 'bitgo'

  result.addWebhook({ url: prefix + '/callbacks/bitgo/sink', type: 'transaction', numConfirmations: 1 }, function (err) {
    if (err) debug('wallet addWebhook', { label: label, message: err.toString() })

    result.setPolicyRule({ id: 'com.brave.limit.velocity.30d',
                           type: 'velocityLimit',
                           condition: { type: 'velocity',
                                        amount: 7000000,
                                        timeWindow: 30 * 86400,
                                        groupTags: [],
                                        excludeTags: []
                                      },
                           action: { type: 'deny' } }, function (err) {
      if (err) debug('wallet setPolicyRule', { label: label, message: err.toString() })
    })
  })

  return result
}

Wallet.prototype.balances = async function (info) {
  var f = Wallet.providers[info.provider].balances

  if (!f) throw new Error('provider ' + info.provider + ' balances not supported')
  return await f.bind(this)(info)
}

Wallet.prototype.purchaseBTC = function (info, amount, currency) {
  var f = Wallet.providers[info.provider].purchaseBTC

  if (!f) f = Wallet.providers.coinbase.purchaseBTC
  if (!f) return {}
  return f.bind(this)(info, amount, currency)
}

Wallet.prototype.recurringBTC = function (info, amount, currency) {
  var f = Wallet.providers[info.provider].recurringBTC

  if (!f) f = Wallet.providers.coinbase.recurringBTC
  if (!f) return {}
  return f.bind(this)(info, amount, currency)
}

Wallet.prototype.recover = async function (info, original, passphrase) {
  var f = Wallet.providers[info.provider].recover

  if (!f) throw new Error('provider ' + info.provider + ' recover not supported')
  return await f.bind(this)(info, original, passphrase)
}

Wallet.prototype.submitTx = async function (info, signedTx) {
  var f = Wallet.providers[info.provider].submitTx

  if (!f) throw new Error('provider ' + info.provider + ' submitTx not supported')
  return await f.bind(this)(info, signedTx)
}

Wallet.prototype.unsignedTx = async function (info, amount, currency, balance) {
  var f = Wallet.providers[info.provider].unsignedTx

  if (!f) throw new Error('provider ' + info.provider + ' unsignedTx not supported')
  return await f.bind(this)(info, amount, currency, balance)
}

Wallet.prototype.rates = {}

var schema = Joi.object({}).pattern(/timestamp|[A-Z][A-Z][A-Z]/,
                                    Joi.alternatives().try(Joi.date(),
                                                           Joi.object().keys({ last: Joi.number().positive() }).unknown(true)))
                .required()

var maintenance = async function () {
  var rates, result, validity

  try {
    result = JSON.parse(await braveHapi.wreck.get('https://api.bitcoinaverage.com/ticker/global/all'))
    validity = Joi.validate(result, schema)
    if (validity.error) throw new Error(validity.error)

    rates = {}
    underscore.keys(result).forEach(currency => {
      var rate = result[currency]

      if ((typeof rate !== 'object') || (!rate.last)) return

      rates[currency] = rate.last
    })

    Wallet.prototype.rates = rates
  } catch (ex) {
    debug('maintenance error', ex)
  }
}

module.exports = Wallet

maintenance()
setInterval(maintenance, 5 * 60 * 1000)

Wallet.providers = {}

Wallet.providers.bitgo = {
  balances: async function (info) {
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })

    return { balance: wallet.balance(),
             spendable: wallet.spendableBalance(),
             confirmed: wallet.confirmedBalance(),
             unconfirmed: wallet.unconfirmedReceives()
           }
  },

  recover: async function (info, original, passphrase) {
    var amount, result
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: original.address })

    amount = wallet.balance()
    result = await wallet.sendCoins({ address: info.address, amount: amount, walletPassphrase: passphrase })
console.log(JSON.stringify(result, null, 2))
  },

  submitTx: async function (info, signedTx) {
    var details, i, result
    var wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })

    result = await wallet.sendTransaction({ tx: signedTx })

// courtesy of https://stackoverflow.com/questions/33289726/combination-of-async-function-await-settimeout#33292942
    var timeout = function (msec) { return new Promise((resolve) => { setTimeout(resolve, msec) }) }

    for (i = 0; i < 5; i++) {
      try {
        details = await this.bitgo.blockchain().getTransaction({ id: result.hash })
        break
      } catch (ex) {
        debug('getTransaction', ex)
        await timeout(1 * 1000)
        debug('getTransaction', { retry: i + 1, max: 5 })
      }
    }
    underscore.extend(result, { fee: details.fee })

    for (i = details.outputs.length - 1; i >= 0; i--) {
      if (details.outputs[i].account !== this.config.bitgo.settlementAddress) continue

      underscore.extend(result, { address: details.outputs[i].account, satoshis: details.outputs[i].value })
      break
    }

    return result
  },

  unsignedTx: async function (info, amount, currency, balance) {
    var desired, i, minimum, transaction, wallet
    var estimate = await this.bitgo.estimateFee({ numBlocks: 6 })
    var fee = estimate.feePerKb
    var rate = Wallet.prototype.rates[currency.toUpperCase()]
    var recipients = {}

    if (!rate) throw new Error('no such currency: currency')

    desired = (amount / rate) * 1e8
    minimum = Math.floor(desired * 0.90)
    desired = Math.round(desired)
    debug('unsignedTx', { balance: balance, desired: desired, minimum: minimum })
    if (minimum > balance) return

    if (desired > balance) desired = balance

    wallet = await this.bitgo.wallets().get({ type: 'bitcoin', id: info.address })
    for (i = 0; i < 2; i++) {
      recipients[this.config.bitgo.settlementAddress] = desired - fee

      try {
        transaction = await wallet.createTransaction({ recipients: recipients, feeRate: estimate.feePerKb })
        debug('unsignedTx', { satoshis: desired, estimate: fee, actual: transaction.fee })
      } catch (ex) {
        debug('createTransaction', ex)
        return
      }
      if (fee <= transaction.fee) break

      fee = transaction.fee
    }

    return underscore.extend(underscore.pick(transaction, [ 'transactionHex', 'unspents', 'fee' ]),
                             { xpub: transaction.walletKeychains[0].xpub })
  }
}

Wallet.providers.coinbase = {
  purchaseBTC: function (info, amount, currency) {
    // TBD: for the moment...
    if (currency !== 'USD') throw new Error('currency ' + currency + ' payment not supported')

    return ({ buyURL: `https://buy.coinbase.com?crypto_currency=BTC` +
                `&code=${this.config.coinbase.widgetCode}` +
                `&amount=${amount}` +
                `&address=${info.address}`
            })
  },

  recurringBTC: function (info, amount, currency) {
    // TBD: for the moment...
    if (currency !== 'USD') throw new Error('currency ' + currency + ' payment not supported')

    return ({ recurringURL: `https://www.coinbase.com/recurring_payments/new?type=send&repeat=monthly` +
                `&amount=${amount}` +
                `&currency=${currency}` +
                `&to=${info.address}`
            })
  }
}
