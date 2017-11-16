'use strict'

const { log, BaseKonnector, saveBills, request } = require('cozy-konnector-libs')
const moment = require('moment')
moment.locale('fr')
const bluebird = require('bluebird')

const urlService = require('./urlService')

let rq = request({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const getFileName = date => `${moment(date).format('YYYYMMDD')}_ameli.pdf`

const parseAmount = amount => parseFloat(amount.replace(' €', '').replace(',', '.'))

const trimText = cheerioElmt => cheerioElmt.text().trim()

const checkLogin = fields => {
  log('info', 'Checking the length of the login')
  let fixedLogin = fields.login
  if (fields.login.length > 13) {
    // remove the key from the social security number
    fixedLogin = fields.login.substr(0, 13)
    log('debug', `Fixed the login length to 13`)
  }

  return Promise.resolve({
    login: fixedLogin,
    password: fields.password
  })
}

// Procedure to login to Ameli website.
const logIn = (login, password) => {
  log('info', 'Now logging in')

  const form = {
    connexioncompte_2numSecuriteSociale: login,
    connexioncompte_2codeConfidentiel: password,
    connexioncompte_2actionEvt: 'connecter',
    submit: 'Valider'
  }

  return (
    // First request to get the cookie
    rq({
      url: urlService.getLoginUrl(),
      resolveWithFullResponse: true
    })
      // Second request to authenticate
      .then(res =>
        rq({
          method: 'POST',
          form,
          url: urlService.getSubmitUrl()
        })
      )
      .then($ => {
        const $errors = $('#r_errors')
        if ($errors.length > 0) {
          log('debug', $errors.text(), 'These errors where found on screen')
          throw new Error('LOGIN_FAILED')
        }

        // The user must validate the CGU form
        const $cgu = $('meta[http-equiv=refresh]')
        if ($cgu.length > 0 && $cgu.attr('content').includes('as_conditions_generales_page')) {
          log('debug', $cgu.attr('content'))
          throw new Error('USER_ACTION_NEEDED')
        }

        // Default case. Something unexpected went wrong after the login
        if ($('[title="Déconnexion du compte ameli"]').length !== 1) {
          log('debug', $('body').html(), 'No deconnection link found in the html')
          log('debug', 'Something unexpected went wrong after the login')
          throw new Error('LOGIN_FAILED')
        }

        log('info', 'Correctly logged in')
        return rq(urlService.getReimbursementUrl())
      })
  )
}

// fetch the HTML page with the list of health cares
const fetchReimbursements = $ => {
  log('info', 'Fetching the list of bills')

  // Get end date to generate the bill's url
  const endDate = moment($('#paiements_1dateFin').attr('value'), 'DD/MM/YYYY')

  // We can get the history only 6 months back
  const billUrl = urlService.getBillUrl(endDate, 6)

  return rq(billUrl)
}

// Parse the fetched page to extract bill data.
const parseReimbursements = $ => {
  const reimbursements = []
  let i = 0

  // Each bloc represents a month that includes 0 to n reimbursement
  $('.blocParMois').each((index, elmt) => {
    // It would be too easy to get the full date at the same place
    let year = $(
      $(elmt)
        .find('.rowdate .mois')
        .get(0)
    ).text()
    year = year.split(' ')[1]

    return $(`[id^=lignePaiement${i++}]`).each((index, elmt) => {
      const month = $(
        $(elmt)
          .find('.col-date .mois')
          .get(0)
      ).text()
      const day = $(
        $(elmt)
          .find('.col-date .jour')
          .get(0)
      ).text()
      let date = `${day} ${month} ${year}`
      date = moment(date, 'Do MMMM YYYY')

      // Retrieve and extract the infos needed to generate the pdf
      const attrInfos = $(elmt).attr('onclick')
      const tokens = attrInfos.split("'")

      const idPaiement = tokens[1]
      const naturePaiement = tokens[3]
      const indexGroupe = tokens[5]
      const indexPaiement = tokens[7]

      const detailsUrl = urlService.getDetailsUrl(
        idPaiement,
        naturePaiement,
        indexGroupe,
        indexPaiement
      )

      let lineId = `${indexGroupe}${indexPaiement}`

      let reimbursement = {
        date,
        lineId,
        detailsUrl,
        isThirdPartyPayer: naturePaiement === 'PAIEMENT_A_UN_TIERS',
        beneficiaries: {}
      }

      reimbursements.push(reimbursement)
    })
  })
  return bluebird
    .each(reimbursements, reimbursement => {
      return rq(reimbursement.detailsUrl).then($ => parseDetails($, reimbursement))
    })
    .then(() => reimbursements)
}

const parseDetails = ($, reimbursement) => {
  let currentBeneficiary = null
  reimbursement.link = $('.entete [id^=liendowndecompte]').attr('href')
  $('.container:not(.entete)').each(function () {
    const $beneficiary = $(this).find('[id^=nomBeneficiaire]')
    if ($beneficiary.length > 0) {
      // a beneficiary container
      currentBeneficiary = trimText($beneficiary)
      return null
    }

    // the next container is the list of health cares associated to the beneficiary
    if (currentBeneficiary) {
      parseHealthCares($, this, currentBeneficiary, reimbursement)
      currentBeneficiary = null
    } else {
      // there is some participation remaining for the whole reimbursement
      parseParticipation($, this, reimbursement)
    }
  })
}

const parseHealthCares = ($, container, beneficiary, reimbursement) => {
  $(container)
    .find('tr')
    .each((index, elmt) => {
      if ($(elmt).find('th').length > 0) {
        return null // ignore header
      }

      const date = $(elmt)
        .find('[id^=Nature]')
        .html()
        .split('<br>')
        .pop()
        .trim()
      const momentDate = moment(date, 'DD/MM/YYYY')
      const healthCare = {
        prestation: trimText($(elmt).find('.naturePrestation')),
        date: momentDate,
        montantPayé: parseAmount(trimText($(elmt).find('[id^=montantPaye]'))),
        baseRemboursement: parseAmount(trimText($(elmt).find('[id^=baseRemboursement]'))),
        taux: trimText($(elmt).find('[id^=taux]')),
        montantVersé: parseAmount(trimText($(elmt).find('[id^=montantVerse]')))
      }

      reimbursement.beneficiaries[beneficiary] = reimbursement.beneficiaries[beneficiary] || []
      reimbursement.beneficiaries[beneficiary].push(healthCare)
    })
}

const parseParticipation = ($, container, reimbursement) => {
  $(container)
    .find('tr')
    .each(function () {
      if ($(this).find('th').length > 0) {
        return null // ignore header
      }

      if (reimbursement.participation) {
        log('warning', 'There is already a participation, this case is not supposed to happend')
      }
      const date = trimText($(this).find('[id^=dateActePFF]'))
      const momentDate = moment(date, 'DD/MM/YYYY')
      reimbursement.participation = {
        prestation: trimText($(this).find('[id^=naturePFF]')),
        date: momentDate,
        montantVersé: parseAmount(trimText($(this).find('[id^=montantVerse]')))
      }
    })
}

const getBills = reimbursements => {
  const bills = []
  reimbursements.forEach(reimbursement => {
    for (const beneficiary in reimbursement.beneficiaries) {
      reimbursement.beneficiaries[beneficiary].forEach(healthCare => {
        bills.push({
          type: 'health',
          subtype: healthCare.prestation,
          beneficiary,
          isThirdPartyPayer: reimbursement.isThirdPartyPayer,
          date: reimbursement.date.toDate(),
          originalDate: healthCare.date.toDate(),
          vendor: 'Ameli',
          amount: healthCare.montantVersé,
          originalAmount: healthCare.montantPayé,
          fileurl: 'https://assure.ameli.fr' + reimbursement.link,
          filename: getFileName(reimbursement.date)
        })
      })
    }

    if (reimbursement.participation) {
      bills.push({
        type: 'health',
        subtype: reimbursement.participation.prestation,
        isThirdPartyPayer: reimbursement.isThirdPartyPayer,
        date: reimbursement.date.toDate(),
        originalDate: reimbursement.participation.date.toDate(),
        vendor: 'Ameli',
        amount: reimbursement.participation.montantVersé,
        fileurl: 'https://assure.ameli.fr' + reimbursement.link,
        filename: getFileName(reimbursement.date)
      })
    }
  })
  return bills
}

module.exports = new BaseKonnector(function fetch (fields) {
  return checkLogin(fields)
    .then(({ login, password }) => logIn(login, password))
    .then($ => fetchReimbursements($))
    .then($ => parseReimbursements($))
    .then(reimbursements => getBills(reimbursements))
    .then(entries => {
      // get custom bank identifier if any
      let identifiers = 'C.P.A.M.'
      if (fields.bank_identifier && fields.bank_identifier.length) {
        identifiers = fields.bank_identifier
      }

      return saveBills(entries, fields.folderPath, {
        timeout: Date.now() + 60 * 1000,
        identifiers,
        dateDelta: 10,
        amountDelta: 0.1
      })
    })
})
