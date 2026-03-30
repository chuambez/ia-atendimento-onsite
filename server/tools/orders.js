const shopify = require('../shopify');

async function handleGetOrderStatus({ order_number, cpf }) {
  if (!order_number || !cpf) {
    return { found: false, message: 'Informe o número do pedido e o CPF para consultar.' };
  }

  let result;
  try {
    result = await shopify.getOrderByNumberAndCPF(order_number, cpf);
  } catch (err) {
    return {
      found: false,
      message: 'Não consegui consultar esse pedido agora. Tente novamente em instantes.',
      error: err.message,
    };
  }

  if (!result.found) {
    return { found: false, message: result.reason };
  }

  const { order } = result;

  const statusMap = {
    pending: 'Aguardando pagamento',
    authorized: 'Pagamento autorizado',
    partially_paid: 'Parcialmente pago',
    paid: 'Pago',
    partially_refunded: 'Parcialmente reembolsado',
    refunded: 'Reembolsado',
    voided: 'Cancelado',
  };

  const fulfillmentMap = {
    fulfilled: 'Enviado',
    partial: 'Parcialmente enviado',
    unfulfilled: 'Aguardando envio',
    restocked: 'Devolvido ao estoque',
  };

  return {
    found: true,
    order_number: order.number,
    payment_status: statusMap[order.status] || order.status,
    shipping_status: fulfillmentMap[order.fulfillment_status] || 'Aguardando envio',
    total: `R$ ${parseFloat(order.total).toFixed(2).replace('.', ',')}`,
    items: order.items,
    tracking: order.tracking
      ? {
          carrier: order.tracking.company || 'Transportadora não informada',
          code: order.tracking.number || 'Código não disponível',
          url: order.tracking.url || null,
          status: order.tracking.status,
        }
      : null,
  };
}

module.exports = { handleGetOrderStatus };
