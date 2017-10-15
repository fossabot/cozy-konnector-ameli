'use strict'

const {log, BaseKonnector, saveBills, request} = require('cozy-konnector-libs')
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

module.exports = new BaseKonnector(function fetch (fields) {
  return checkLogin(fields)
  .then(() => logIn(fields))
  .then($ => fetchMainPage($))
  .then($ => parseMainPage($))
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

const checkLogin = function (fields) {
  log('info', 'Checking the length of the login')
  if (fields.login.length > 13) {
    // remove the key from the social security number
    fields.login = fields.login.substr(0, 13)
    log('debug', `Fixed the login length to 13`)
  }

  return Promise.resolve()
}

// Procedure to login to Ameli website.
const logIn = function (fields) {
  log('info', 'Now logging in')

  const form = {
    'connexioncompte_2numSecuriteSociale': fields.login,
    'connexioncompte_2codeConfidentiel': fields.password,
    'connexioncompte_2actionEvt': 'connecter',
    'submit': 'Valider'
  }

  return rq({
    url: urlService.getLoginUrl(),
    resolveWithFullResponse: true
  })
  // First request to get the cookie
  .then(res => rq({
    method: 'POST',
    form,
    url: urlService.getSubmitUrl()
  }))
  // Second request to authenticate
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
}

// fetch the HTML page with the list of health cares
const fetchMainPage = function ($) {
  log('info', 'Fetching the list of bills')

  // Get end date to generate the bill's url
  const endDate = moment($('#paiements_1dateFin').attr('value'), 'DD/MM/YYYY')

  // We can get the history only 6 months back
  const billUrl = urlService.getBillUrl(endDate, 6)

  return rq(billUrl)
}

// Parse the fetched page to extract bill data.
const parseMainPage = function ($) {
  const reimbursements = []
  let i = 0

  // Each bloc represents a month that includes 0 to n reimbursement
  $('.blocParMois').each(function () {
    // It would be too easy to get the full date at the same place
    let year = $($(this).find('.rowdate .mois').get(0)).text()
    year = year.split(' ')[1]

    return $(`[id^=lignePaiement${i++}]`).each(function () {
      const month = $($(this).find('.col-date .mois').get(0)).text()
      const day = $($(this).find('.col-date .jour').get(0)).text()
      let date = `${day} ${month} ${year}`
      date = moment(date, 'Do MMMM YYYY')

      // Retrieve and extract the infos needed to generate the pdf
      const attrInfos = $(this).attr('onclick')
      const tokens = attrInfos.split("'")

      const idPaiement = tokens[1]
      const naturePaiement = tokens[3]
      const indexGroupe = tokens[5]
      const indexPaiement = tokens[7]

      const detailsUrl = urlService.getDetailsUrl(idPaiement, naturePaiement, indexGroupe, indexPaiement)

      let lineId = indexGroupe + indexPaiement

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
  return bluebird.each(reimbursements, reimbursement => {
    return rq(reimbursement.detailsUrl)
    .then($ => parseDetails($, reimbursement))
  })
  .then(() => reimbursements)
}

function parseDetails ($, reimbursement) {
  let currentBeneficiary = null
  reimbursement.link = $('.entete [id^=liendowndecompte]').attr('href')
  $('.container:not(.entete)').each(function () {
    const $beneficiary = $(this).find('[id^=nomBeneficiaire]')
    if ($beneficiary.length > 0) { // a beneficiary container
      currentBeneficiary = $beneficiary.text().trim()
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

function parseAmount (amount) {
  return parseFloat(amount.replace(' €', '').replace(',', '.'))
}

function parseHealthCares ($, container, beneficiary, reimbursement) {
  $(container).find('tr').each(function () {
    if ($(this).find('th').length > 0) {
      return null // ignore header
    }

    let date = $(this).find('[id^=Nature]').html().split('<br>').pop().trim()
    date = moment(date, 'DD/MM/YYYY')
    const healthCare = {
      prestation: $(this).find('.naturePrestation').text().trim(),
      date,
      montantPayé: parseAmount($(this).find('[id^=montantPaye]').text().trim()),
      baseRemboursement: parseAmount($(this).find('[id^=baseRemboursement]').text().trim()),
      taux: $(this).find('[id^=taux]').text().trim(),
      montantVersé: parseAmount($(this).find('[id^=montantVerse]').text().trim())
    }

    reimbursement.beneficiaries[beneficiary] = reimbursement.beneficiaries[beneficiary] || []
    reimbursement.beneficiaries[beneficiary].push(healthCare)
  })
}

function parseParticipation ($, container, reimbursement) {
  $(container).find('tr').each(function () {
    if ($(this).find('th').length > 0) {
      return null // ignore header
    }

    if (reimbursement.participation) {
      log('warning', 'There is already a participation, this case is not supposed to happend')
    }
    let date = $(this).find('[id^=dateActePFF]').text().trim()
    date = moment(date, 'DD/MM/YYYY')
    reimbursement.participation = {
      prestation: $(this).find('[id^=naturePFF]').text().trim(),
      date,
      montantVersé: parseAmount($(this).find('[id^=montantVerse]').text().trim())
    }
  })
}

function getBills (reimbursements) {
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

function getFileName (date) {
  return `${moment(date).format('YYYYMMDD')}_ameli.pdf`
}
