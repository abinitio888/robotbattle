// Allt som rör jokerns namn, attack och utseende — samlat i EN serverlös funktion (se
// dispatch() i _lib.js) för att hålla sig inom Vercels gräns på 12 funktioner.
const { dispatch, acctAction, S } = require('../_lib.js');

module.exports = dispatch({
  name: { method: 'POST', handler: acctAction((acct, body) => S.nameWildcard(acct, typeof body.name === 'string' ? body.name : '')) },
  special: { method: 'POST', handler: acctAction((acct, body) => S.chooseWildcardSpecial(acct, body.type === undefined ? null : body.type)) },
  attack: { method: 'POST', handler: acctAction((acct, body) => S.setCustomWildcardSpecial(acct, body.type, body.name, body.desc, body.dmg, body.heal, body.types)) },
  color: { method: 'POST', handler: acctAction((acct, body) => S.setWildcardColor(acct, typeof body.hex === 'string' ? body.hex : null)) },
  head: { method: 'POST', handler: acctAction((acct, body) => S.setWildcardHead(acct, typeof body.head === 'string' ? body.head : null)) },
  extra: { method: 'POST', handler: acctAction((acct, body) => S.setWildcardExtra(acct, typeof body.extra === 'string' ? body.extra : null)) },
});
