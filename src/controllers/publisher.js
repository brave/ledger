var boom = require('boom')
var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var ledgerPublisher = require('ledger-publisher')
var path = require('path')
var underscore = require('underscore')

var v1 = {}
var v2 = {}

var rulesetId = 1

var rulesetEntry = async function (request, runtime) {
  var entry
  var debug = braveHapi.debug(module, request)
  var version = runtime.npminfo.children['ledger-publisher']
  var rulesets = runtime.db.get('rulesets', debug)

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  if ((!entry) || (entry.version.indexOf(version) !== 0)) {
    if (entry) rulesets.remove({ rulesetId: rulesetId })

    entry = { ruleset: ledgerPublisher.ruleset, version: version }
  }

  return entry
}

var rulesetEntryV2 = async function (request, runtime) {
  var entryV2 = await rulesetEntry(request, runtime)
  var ruleset = []

  entryV2.ruleset.forEach(rule => { if (rule.consequent) ruleset.push(rule) })

  return { ruleset: ruleset, version: entryV2.version }
}

var publisherV2 = { publisher: Joi.string().required().description('the publisher identity') }

var propertiesV2 =
  {
    facet: Joi.string().valid('domain', 'SLD', 'TLD').optional().default('domain').description('the entry type'),
    exclude: Joi.boolean().optional().default(true).description('exclude from auto-include list'),
    tags: Joi.array().items(Joi.string()).optional().description('taxonomy tags')
  }

var schemaV2 = Joi.object().keys(underscore.extend({}, publisherV2, propertiesV2,
  { timestamp: Joi.string().regex(/^[0-9]+$/).required().description('an opaque, monotonically-increasing value') },
))

/*
   GET /v1/publisher/ruleset
   GET /v2/publisher/ruleset
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    var consequential = request.query.consequential
    var entry = consequential ? (await rulesetEntryV2(request, runtime)) : (await rulesetEntry(request, runtime))

    return reply(entry.ruleset)
  }
},

  description: 'Returns the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { query: { consequential: Joi.boolean().optional().default(false).description('return only consequential rules') } },

  response:
    { schema: ledgerPublisher.schema }
}

v2.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entries, modifiers, query, result
    var debug = braveHapi.debug(module, request)
    var limit = parseInt(request.query.limit, 10)
    var timestamp = request.query.timestamp
    var publishers = runtime.db.get('publishersV2', debug)

    try { timestamp = (timestamp || 0) ? bson.Timestamp.fromString(timestamp) : bson.Timestamp.ZERO } catch (ex) {
      return reply(boom.badRequest('invalid value for the timestamp parameter: ' + timestamp))
    }

    if (isNaN(limit) || (limit > 512)) limit = 512
    query = { timestamp: { $gte: timestamp } }
    modifiers = { sort: { timestamp: 1 } }

    entries = await publishers.find(query, underscore.extend({ limit: limit }, modifiers))
    result = []
    entries.forEach(entry => {
      if (entry.publisher === '') return

      result.push(underscore.extend(underscore.omit(entry, [ '_id', 'timestamp' ]),
                                    { timestamp: entry.timestamp.toString() }))
    })

    reply(result)
  }
},

  description: 'Returns information about publisher identity ruleset entries',
  tags: [ 'api' ],

  validate:
    { query:
      { timestamp: Joi.string().regex(/^[0-9]+$/).optional().description('an opaque, monotonically-increasing value'),
        limit: Joi.number().positive().max(512).optional().description('the maximum number of entries to return')
      }
    },

  response:
  { schema: Joi.array().items(
            )
  }
}

/*
   POST /v1/publisher/ruleset
   POST /v2/publisher/ruleset
 */

v1.create =
{ handler: function (runtime) {
  return async function (request, reply) {
    var state
    var debug = braveHapi.debug(module, request)
    var version = runtime.npminfo.children['ledger-publisher'] + '-' + underscore.now()
    var rulesets = runtime.db.get('rulesets', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { ruleset: request.payload, version: version, type: 'publisher/ruleset' }
            }
    await rulesets.update({ rulesetId: rulesetId }, state, { upsert: true })

    reply(version)
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Defines a publisher identity ruleset entry',
  tags: [ 'api' ],

  validate:
    { payload: ledgerPublisher.schema },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]+$/) }
}

v2.create =
{ handler: function (runtime) {
  return async function (request, reply) {
    var result
    var debug = braveHapi.debug(module, request)
    var payload = request.payload
    var publisher = payload.publisher
    var publishers = runtime.db.get('publishersV2', debug)

    result = await publishers.findOne({ publisher: publisher })
    if (result) return reply(boom.badData('publisher identity entry already exists: ' + publisher))

    try {
      await publishers.insert(underscore.extend(payload, { timestamp: bson.Timestamp() }))
    } catch (ex) {
      debug('insert failed for publishers', ex)
      return reply(boom.badData(ex.toString()))
    }

    result = await publishers.findOne({ publisher: publisher })
    if (!result) return reply(boom.badImplementation('database creation failed: ' + publisher))

    result = underscore.extend(underscore.omit(result, [ '_id', 'timestamp' ]), { timestamp: result.timestamp.toString() })

    reply(result)
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Defines information a new publisher identity ruleset entry',
  tags: [ 'api' ],

  validate:
  { payload: underscore.extend({}, publisherV2, propertiesV2) },

  response:
    { schema: schemaV2 }
}

/*
   PUT /v2/publisher/ruleset/{publisher}
 */

v2.write =
{ handler: function (runtime) {
  return async function (request, reply) {
    var result, state
    var debug = braveHapi.debug(module, request)
    var publisher = request.params.publisher
    var publishers = runtime.db.get('publishersV2', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: request.payload
            }
    await publishers.update({ publisher: publisher }, state, { upsert: true })

    result = await publishers.findOne({ publisher: publisher })
    if (!result) return reply(boom.badImplementation('database update failed: ' + publisher))

    result = underscore.extend(underscore.omit(result, [ '_id', 'timestamp' ]), { timestamp: result.timestamp.toString() })

    reply(result)
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'devops' ],
      mode: 'required'
    },

  description: 'Sets information for a publisher identity ruleset entry',
  tags: [ 'api' ],

  validate:
    { params: publisherV2,
      payload: Joi.object().keys(propertiesV2)
    },

  response:
    { schema: schemaV2 }
}

/*
   DELETE /v1/publisher/ruleset
   DELETE /v2/publisher/ruleset/{publisher}
 */

v1.delete =
{ handler: function (runtime) {
  return async function (request, reply) {
    var debug = braveHapi.debug(module, request)
    var rulesets = runtime.db.get('rulesets', debug)

    await rulesets.remove({ rulesetId: rulesetId })

    reply(runtime.npminfo.children['ledger-publisher'])
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Resets the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/) }
}

v2.delete =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entry
    var debug = braveHapi.debug(module, request)
    var publisher = request.params.publisher
    var publishers = runtime.db.get('publishersV2', debug)

    entry = await publishers.findOne({ publisher: publisher })
    if (!entry) return reply(boom.notFound('no such entry: ' + publisher))

    await publishers.remove({ publisher: publisher })

    reply().code(204)
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Deletes information a a publisher identity ruleset entry',
  tags: [ 'api' ],

  validate:
    { params: publisherV2 },

  response:
    { schema: Joi.any() }
}

/*
   GET /v1/publisher/ruleset/version
 */

v1.version =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entry = await rulesetEntry(request, runtime)

    reply(entry.version)
  }
},

  description: 'Returns the version of the publisher identity ruleset',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[1-9]+[0-9]*)?$/) }
}

/*
   GET /v1/publisher/identity?url=...
   GET /v2/publisher/identity?url=...
 */

v1.identity =
{ handler: function (runtime) {
  return async function (request, reply) {
    var result
    var url = request.query.url

    try {
      result = ledgerPublisher.getPublisherProps(url)
      if (result) result.publisher = ledgerPublisher.getPublisher(url)

      reply(result || boom.notFound())
    } catch (ex) {
      reply(boom.badData(ex.toString()))
    }
  }
},

  description: 'Returns the publisher identity associated with a URL',
  tags: [ 'api' ],

  validate:
    { query: { url: Joi.string().uri({ scheme: /https?/ }).required().description('the URL to parse') } },

  response:
    { schema: Joi.object().optional().description('the publisher identity') }
}

v2.identity =
{ handler: function (runtime) {
  return async function (request, reply) {
    var result
    var entry = await rulesetEntryV2(request, runtime)
    var url = request.query.url
    var debug = braveHapi.debug(module, request)
    var publishers = runtime.db.get('publishersV2', debug)

    var re = (value, entries) => {
      entries.forEach((reEntry) => {
        var regexp

        if ((entry) ||
            (underscore.intersection(reEntry.publisher.split(''),
                                  [ '^', '$', '*', '+', '?', '[', '(', '{', '|' ]).length === 0)) return

        try {
          regexp = new RegExp(reEntry.publisher)
          if (regexp.test(value)) entry = reEntry
        } catch (ex) {
          debug('invalid regexp ' + reEntry.publisher + ': ' + ex.toString())
        }
      })
    }

    try {
      result = ledgerPublisher.getPublisherProps(url)
      if (!result) return reply(boom.notFound())

      result.publisher = ledgerPublisher.getPublisher(url, entry.ruleset)
      if (result.publisher) {
        entry = await publishers.findOne({ publisher: result.publisher, facet: 'domain' })

        if (!entry) entry = await publishers.findOne({ publisher: result.SLD.split('.')[0], facet: 'SLD' })
        if (!entry) re(result.SLD, await publishers.find({ facet: 'SLD' }))

        if (!entry) entry = await publishers.findOne({ publisher: result.TLD, facet: 'TLD' })
        if (!entry) re(result.TLD, await publishers.find({ facet: 'TLD' }))

        if (entry) {
          result.properties = underscore.omit(entry, [ '_id', 'publisher', 'timestamp' ])
          result.timestamp = entry.timestamp.toString()
        }
      }

      reply(result)
    } catch (ex) {
      reply(boom.badData(ex.toString()))
    }
  }
},

  description: 'Returns the publisher identity associated with a URL',
  tags: [ 'api' ],

  validate:
    { query: { url: Joi.string().uri({ scheme: /https?/ }).required().description('the URL to parse') } },

  response:
    { schema: Joi.object().optional().description('the publisher identity') }
}

/*
   GET /v1/publisher/identity/verified
 */

v1.verified =
{ handler: function (runtime) {
  return async function (request, reply) {
    var entries, result
    var limit = request.query.limit
    var tld = request.query.tld || { $exists: true }
    var debug = braveHapi.debug(module, request)
    var publishers = runtime.db.get('publishers', debug)

    entries = await publishers.find({ verified: true, tld: tld }, { fields: { publisher: 1 }, limit: limit })
    result = []
    entries.forEach((entry) => { result.push(entry.publisher) })
    reply(result)
  }
},

  description: 'Returns a list of verified publishers',
  tags: [ 'api' ],

  validate:
    { query: { limit: Joi.number().integer().positive().default(500).description('maximum number of matches'),
               tld: Joi.string().hostname().optional().description('a suffix-matching string') } },

  response:
    { schema: Joi.array().items(Joi.string()).description('verified publishers') }
}

module.exports.routes = [
  braveHapi.routes.async().get().path('/v1/publisher/ruleset').config(v1.read),
  braveHapi.routes.async().post().path('/v1/publisher/ruleset').config(v1.create),
  braveHapi.routes.async().delete().path('/v1/publisher/ruleset').config(v1.delete),
  braveHapi.routes.async().get().path('/v1/publisher/ruleset/version').config(v1.version),
  braveHapi.routes.async().get().path('/v1/publisher/identity').config(v1.identity),

  braveHapi.routes.async().get().path('/v2/publisher/ruleset').config(v2.read),
  braveHapi.routes.async().post().path('/v2/publisher/ruleset').config(v2.create),
  braveHapi.routes.async().put().path('/v2/publisher/ruleset/{publisher}').config(v2.write),
  braveHapi.routes.async().delete().path('/v2/publisher/ruleset/{publisher}').config(v2.delete),
  braveHapi.routes.async().get().path('/v2/publisher/identity').config(v2.identity),

  braveHapi.routes.async().get().path('/v1/publisher/identity/verified').config(v1.verified)
]

module.exports.initialize = async function (debug, runtime) {
  var categories, entry, validity
  var publishers = runtime.db.get('publishersV2', debug)
  var rulesets = runtime.db.get('rulesets', debug)

  runtime.db.checkIndices(debug,
  [ { category: rulesets,
      name: 'rulesets',
      property: 'rulesetId',
      empty: { rulesetId: 0, type: '', version: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { rulesetId: 1 } ],
      others: [ { type: 1 }, { version: 1 }, { timestamp: 1 } ]
    },
    { category: runtime.db.get('publishers', debug),
      name: 'publishers',
      property: 'publisher',
      empty: { publisher: '', tld: '', verified: false, timestamp: bson.Timestamp.ZERO },
      unique: [ { publisher: 1 } ],
      others: [ { tld: 1 }, { verified: 1 }, { timestamp: 1 } ]
    },
    { category: publishers,
      name: 'publishersV2',
      property: 'publisher',
      empty: { publisher: '', facet: '', exclude: false, tags: [], timestamp: bson.Timestamp.ZERO },
      unique: [ { publisher: 1 } ],
      others: [ { facet: 1 }, { exclude: 1 }, { timestamp: 1 } ]
    }
  ])

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  validity = Joi.validate(entry ? entry.ruleset : ledgerPublisher.ruleset, ledgerPublisher.schema)
  if (validity.error) throw new Error(validity.error)

  ledgerPublisher.getRules(function (err, rules) {
    var validity

    if (err) runtime.newrelic.noticeError(err, { ledgerPublisher: 'getRules' })
    if ((!rules) || (underscore.isEqual(ledgerPublisher.ruleset, rules))) return

    validity = Joi.validate(rules, ledgerPublisher.schema)
    if (validity.error) return runtime.newrelic.noticeError(new Error(validity.error), { ledgerPublisher: 'getRules' })

    ledgerPublisher.ruleset = rules
  })

  entry = await publishers.findOne({ publisher: 'brave.com', facet: 'domain' })
  if (entry) return

  categories = ledgerPublisher.getCategories.categories()
  underscore.keys(categories).forEach((category) => {
    var properties = categories[category]
    var tags = [ underscore.rest(path.parse(category).name.split('-')).join('-') ]

    underscore.keys(properties).forEach(function (facet) {
      properties[facet].forEach(function (value) {
        try {
          publishers.insert({ publisher: value, facet: facet, exclude: true, tags: tags, timestamp: bson.Timestamp() })
        } catch (ex) {
          debug('insert failed for publishers', ex)
        }
      })
    })
  })
}
