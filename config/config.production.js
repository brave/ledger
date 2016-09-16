module.exports =
{ port                  : process.env.PORT
, database              :
  { mongo               : process.env.MONGODB_URI }
, queue                 :
  { rsmq                : process.env.REDIS_URL }
, wallet                :
  { bitgo               :
    { accessToken       : process.env.BITGO_TOKEN
    , enterpriseId      : process.env.BITGO_ENTERPRISE_ID
    , environment       : process.env.BITGO_ENVIRONMENT
    , settlementAddress : process.env.BITGO_SETTLEMENT_ADDRESS
    , unspendableXpub   : process.env.BITGO_UNSPENDABLE_XPUB
    }
  , coinbase            :
    { widgetCode        : process.env.COINBASE_WIDGET_CODE }
  }
, login                 :
  { organization        : 'brave'
  , world               : '/documentation'
  , bye                 : 'https://brave.com'
  , clientId            : process.env.GITHUB_CLIENT_ID
  , clientSecret        : process.env.GITHUB_CLIENT_SECRET
  , ironKey             : process.env.IRON_KEYPASS
  , isSecure            : true
  }
}
