var anonize = require('node-anonize2-relic')
var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var Joi = require('joi')
var timestamp = require('monotonic-timestamp')
var underscore = require('underscore')

var v1 = {}
var v2 = {}

/*
   GET /v1/wallet/{paymentId}
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    var balances, result, state, wallet
    var amount = request.query.amount
    var balanceP = request.query.balance
    var currency = request.query.currency
    var debug = braveHapi.debug(module, request)
    var paymentId = request.params.paymentId.toLowerCase()
    var refreshP = request.query.refresh
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    result = {
      paymentStamp: wallet.paymentStamp || 0,
      rates: currency ? underscore.pick(runtime.wallet.rates, [ currency.toUpperCase() ]) : runtime.wallet.rates
    }

    if ((refreshP) || (balanceP && !wallet.balances)) {
      balances = await runtime.wallet.balances(wallet)

      if (!underscore.isEqual(balances, wallet.balances)) {
        state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { balances: balances } }
        await wallets.update({ paymentId: paymentId }, state, { upsert: true })

        await runtime.queue.send(debug, 'wallet-report', underscore.extend({ paymentId: paymentId }, state.$set))
      }
    } else {
      balances = wallet.balances
    }
    if (balances) {
      underscore.extend(result, {
        satoshis: balances.confirmed,
        balance: (balances.confirmed / 1e8).toFixed(4),
        unconfirmed: (balances.unconfirmed / 1e8).toFixed(4)
      })
    }

    if ((amount) && (currency)) {
      underscore.extend(result, runtime.wallet.purchaseBTC(wallet, amount, currency))
      underscore.extend(result, runtime.wallet.recurringBTC(wallet, amount, currency))
      if (refreshP) {
        result.unsignedTx = await runtime.wallet.unsignedTx(wallet, amount, currency, balances.confirmed)

        if (result.unsignedTx) {
          state = {
            $currentDate: { timestamp: { $type: 'timestamp' } },
            $set: { unsignedTx: result.unsignedTx.transactionHex }
          }
          await wallets.update({ paymentId: paymentId }, state, { upsert: true })
        }
      }
    }

    reply(result)
  }
},

  description: 'Returns information about the BTC wallet associated with the user',
  tags: [ 'api' ],

  validate: {
    params: { paymentId: Joi.string().guid().required().description('identity of the wallet') },
    query: {
      amount: Joi.number().positive().optional().description('the payment amount in the fiat currency'),
      balance: Joi.boolean().optional().default(false).description('return balance information'),
      currency: braveJoi.string().currencyCode().optional().description('the fiat currency'),
      refresh: Joi.boolean().optional().default(false).description('return balance and transaction information')
    }
  },

  response: {
    schema: Joi.object().keys({
      balance: Joi.number().min(0).optional().description('the (confirmed) wallet balance in BTC'),
      unconfirmed: Joi.number().min(0).optional().description('the unconfirmed wallet balance in BTC'),
      buyURL: Joi.string().uri({ scheme: /https?/ }).optional().description('the URL for an initial payment'),
      recurringURL: Joi.string().uri({ scheme: /https?/ }).optional().description('the URL for recurring payments'),
      paymentStamp: Joi.number().min(0).required().description('timestamp of the last successful payment'),
      rates: Joi.object().optional().description('current exchange rates from BTC to various currencies'),
      satoshis: Joi.number().integer().min(0).optional().description('the wallet balance in satoshis'),
      unsignedTx: Joi.object().optional().description('unsigned transaction')
    })
  }
}

/*
   PUT /v1/wallet/{paymentId}
 */

v1.write =
{ handler: function (runtime) {
  return async function (request, reply) {
    var fee, now, params, result, state, surveyor, surveyorIds, votes, wallet
    var debug = braveHapi.debug(module, request)
    var paymentId = request.params.paymentId.toLowerCase()
    var signedTx = request.payload.signedTx
    var surveyorId = request.payload.surveyorId
    var viewingId = request.payload.viewingId
    var surveyors = runtime.db.get('surveyors', debug)
    var viewings = runtime.db.get('viewings', debug)
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    try {
      if (wallet.unsignedTx) {
        if (!runtime.wallet.compareTx(wallet.unsignedTx, signedTx)) {
          runtime.notify(debug, { channel: '#ledger-bot', text: 'comparison check failed on paymentId ' + paymentId })
        }
      } else {
        runtime.notify(debug, { channel: '#ledger-bot', text: 'unable to perform comparison check for paymentId ' + paymentId })
      }
    } catch (ex) {
      debug('compareTx', ex)
      runtime.notify(debug, { channel: '#ledger-bot', text: 'comparison error on paymentId ' + paymentId })
    }

    surveyor = await surveyors.findOne({ surveyorId: surveyorId })
    if (!surveyor) return reply(boom.notFound('no such surveyor: ' + surveyorId))

    result = await runtime.wallet.submitTx(wallet, signedTx)
/*
    { status   : 'accepted'
    , tx       : '...'
    , hash     : '...'
    , instant  : false,
    , fee      : 7969
    , address  : '...'
    , satoshis : 868886
    }
}
 */
    if (result.status !== 'accepted') return reply(boom.badData(result.status))

    now = timestamp()
    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { paymentStamp: now } }
    await wallets.update({ paymentId: paymentId }, state, { upsert: true })

    params = surveyor.payload.adFree
    votes = Math.round(((result.fee + result.satoshis) / params.satoshis) * params.votes)
    if (votes < 1) votes = 1
    fee = result.fee

    if (!surveyor.surveyors) surveyor.surveyors = []
    if (votes > surveyor.surveyors.length) {
      state = { payload: request.payload, result: result, votes: votes, message: 'insufficient surveyors' }
      debug('wallet', state)
      runtime.notify(debug, {
        channel: '#devops-bot',
        text: 'surveyor ' + surveyor.surveyorId + ' has ' + surveyor.surveyors.length + ', but needed ' + votes
      })
      runtime.newrelic.noticeError(new Error('insufficent surveyors'), state)
    }

    surveyorIds = underscore.shuffle(surveyor.surveyors).slice(0, votes)
    state = {
      $currentDate: { timestamp: { $type: 'timestamp' } },
      $set: {
        surveyorId: surveyorId,
        uId: anonize.uId(viewingId),
        surveyorIds: surveyorIds,
        satoshis: result.satoshis,
        count: votes
      }
    }
    await viewings.update({ viewingId: viewingId }, state, { upsert: true })

    result = { paymentStamp: now, satoshis: result.satoshis, votes: votes, hash: result.hash }
    reply(result)

    await runtime.queue.send(debug, 'contribution-report', underscore.extend({ paymentId: paymentId,
      address: wallet.address,
      surveyorId: surveyorId,
      viewingId: viewingId,
      fee: fee }, result))
  }
},

  description: 'Makes a contribution using the BTC wallet associated with the user',
  tags: [ 'api' ],

  validate: {
    params: { paymentId: Joi.string().guid().required().description('identity of the wallet') },
    payload: {
      viewingId: Joi.string().guid().required().description('unique-identifier for voting'),
      surveyorId: Joi.string().required().description('the identity of the surveyor'),
      signedTx: Joi.string().hex().required().description('signed transaction')
    }
  },

  response: {
    schema: Joi.object().keys({
      paymentStamp: Joi.number().min(0).required().description('timestamp of the last successful contribution'),
      satoshis: Joi.number().integer().min(0).optional().description('the contribution amount in satoshis'),
      votes: Joi.number().integer().min(0).optional().description('the corresponding number of publisher votes'),
      hash: Joi.string().hex().required().description('transaction hash')
    })
  }
}

/*
   PUT /v1/wallet/{paymentId}/recover
   GET /v2/wallet/{paymentId}/recover
 */

v1.recover =
{ handler: function (runtime) {
  return async function (request, reply) {
    var original, satoshis, wallet
    var debug = braveHapi.debug(module, request)
    var paymentId = request.params.paymentId.toLowerCase()
    var passphrase = request.payload.passPhrase
    var recoveryId = request.payload.recoveryId
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    original = await wallets.findOne({ paymentId: recoveryId })
    if (!original) return reply(boom.notFound('no such wallet: ' + recoveryId))

    satoshis = await runtime.wallet.recover(wallet, original, passphrase)

    reply({ satoshis: satoshis })
  }
},

  description: 'Recover the balance of an earlier wallet',
  tags: [ 'api', 'deprecated' ],

  validate: {
    params: { paymentId: Joi.string().guid().required().description('identity of the wallet') },
    payload: {
      recoveryId: Joi.string().guid().required().description('identity of the wallet to be recovered'),
      passPhrase: Joi.string().required().description('the passphrase for the wallet to be recovered')
    }
  },

  response: {
    schema: Joi.object().keys({
      satoshis: Joi.number().integer().min(0).optional().description('the recovered amount in satoshis')
    })
  }

}

v2.recover =
{ handler: function (runtime) {
  return async function (request, reply) {
    var balances, result, state, wallet
    var debug = braveHapi.debug(module, request)
    var paymentId = request.params.paymentId.toLowerCase()
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    balances = await runtime.wallet.balances(wallet)
    if (!underscore.isEqual(balances, wallet.balances)) {
      state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { balances: balances } }
      await wallets.update({ paymentId: paymentId }, state, { upsert: true })

      await runtime.queue.send(debug, 'wallet-report', underscore.extend({ paymentId: paymentId }, state.$set))
    }

    result = underscore.extend({ address: wallet.address,
      keychains: { user: underscore.pick(wallet.keychains.user,
                                                                    [ 'xpub', 'encryptedXprv', 'path' ]) },
      satoshis: balances.confirmed
    })

    reply(result)
  }
},

  description: 'Recover the balance of an earlier wallet',
  tags: [ 'api' ],

  validate:
    { params: { paymentId: Joi.string().guid().required().description('identity of the wallet') } },

  response: {
    schema: Joi.object().keys({
      address: braveJoi.string().base58().required().description('BTC address'),
      keychains: Joi.object().keys({
        user: Joi.object().keys({
          xpub: braveJoi.string().Xpub().required(),
          encryptedXprv: Joi.string().required(),
          path: Joi.string().required()
        }).required()
      }).required(),
      satoshis: Joi.number().integer().min(0).optional().description('the recovered amount in satoshis')
    }).required()
  }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/wallet/{paymentId}').config(v1.read),
  braveHapi.routes.async().put().path('/v1/wallet/{paymentId}').config(v1.write),
  braveHapi.routes.async().put().path('/v1/wallet/{paymentId}/recover').config(v1.recover),
  braveHapi.routes.async().path('/v2/wallet/{paymentId}/recover').config(v2.recover)
]

module.exports.initialize = async function (debug, runtime) {
  runtime.db.checkIndices(debug, [
    {
      category: runtime.db.get('wallets', debug),
      name: 'wallets',
      property: 'paymentId',
      empty: { paymentId: '', address: '', provider: '', balances: {}, paymentStamp: 0, timestamp: bson.Timestamp.ZERO },
      unique: [ { paymentId: 1 }, { address: 1 } ],
      others: [ { provider: 1 }, { paymentStamp: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.db.get('viewings', debug),
      name: 'viewings',
      property: 'viewingId',
      empty: { viewingId: '', uId: '', satoshis: 0, count: 0, surveyorIds: [], timestamp: bson.Timestamp.ZERO },
      unique: [ { viewingId: 1 }, { uId: 1 } ],
      others: [ { satoshis: 1 }, { count: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('wallet-report')
  await runtime.queue.create('contribution-report')
}
