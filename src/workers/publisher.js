var tldjs = require('tldjs')

var exports = {}

exports.workers = {
/* sent when the publisher status updates

    { queue            : 'publisher-report'
    , message          :
      { publisher      : '...'
      , verified       : true
      }
    }
 */
  'publisher-report':
    async function (debug, runtime, payload) {
      var state, tld
      var publisher = payload.publisher
      var verified = payload.verified
      var publishers = runtime.db.get('publishers', debug)

      try {
        tld = tldjs.getPublicSuffix(publisher)
      } catch (ex) {
        debug('publisher-report', { payload: payload, err: ex, stack: ex.stack })
      }
      if (!tld) return debug('publisher-report', 'invalid publisher domain: ' + publisher)

      state = { $currentDate: { timestamp: { $type: 'timestamp' } },
                $set: { verified: verified, tld: tld }
              }
      await publishers.update({ publisher: publisher }, state, { upsert: true })
    }
}

module.exports = exports
