const fs = require('fs');
const path = require('path');

let config = null;

function getConfig() {
  if (!config) {
    const filePath = path.join(__dirname, '../../store-config.json');
    config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return config;
}

function handleGetStoreInfo({ topic }) {
  const cfg = getConfig();

  switch (topic) {
    case 'hours':
      return { topic: 'Horário de funcionamento', info: cfg.hours };
    case 'address':
      return { topic: 'Endereço', info: cfg.address };
    case 'shipping':
      return { topic: 'Frete e entrega', info: cfg.shipping };
    case 'returns':
      return { topic: 'Trocas e devoluções', info: cfg.returns };
    case 'customization':
      return { topic: 'Personalização', info: cfg.customization };
    case 'authenticity':
      return { topic: 'Originalidade dos produtos', info: cfg.authenticity };
    case 'payment':
      return { topic: 'Formas de pagamento', info: cfg.payment };
    case 'faq':
      return { topic: 'Perguntas frequentes', info: cfg.faq };
    default:
      return { topic: 'Informações gerais', info: cfg };
  }
}

module.exports = { handleGetStoreInfo };
