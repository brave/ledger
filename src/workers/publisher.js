var tldjs = require('tldjs')
var underscore = require('underscore')

var exports = {}

exports.workers = {
/* send by eyeshade GET /v1/publishers/{publisher}/verify

    { queue            : 'publisher-report'
    , message          :
      { publisher      : '...'
      , verified       : true | false
      }
    }
 */
  'publisher-report':
    async function (debug, runtime, payload) {
      var state
      var publisher = payload.publisher
      var publishers = runtime.db.get('publishers', debug)
      var tld = tldjs.getPublicSuffix(publisher)

      state = { $currentDate: { timestamp: { $type: 'timestamp' } },
                $set: underscore.extend({ tld: tld }, underscore.omit(payload, [ 'publisher' ]))
              }
      await publishers.update({ publisher: publisher }, state, { upsert: true })
    }
}

module.exports = exports
