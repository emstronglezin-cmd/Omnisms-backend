const PayDunya = require('paydunya');

const setupPayDunya = () => {
  PayDunya.Setup({
    masterKey: process.env.PAYDUNYA_MASTER_KEY,
    privateKey: process.env.PAYDUNYA_PRIVATE_KEY,
    token: process.env.PAYDUNYA_TOKEN,
    mode: process.env.PAYDUNYA_MODE || 'test',
  });
};

const createInvoice = async (invoiceData) => {
  try {
    const invoice = new PayDunya.Checkout.Invoice();
    invoice.addItems(invoiceData.items);
    invoice.setTotalAmount(invoiceData.totalAmount);
    invoice.setDescription(invoiceData.description);

    const response = await invoice.create();
    return response;
  } catch (error) {
    throw new Error(`Failed to create invoice: ${error.message}`);
  }
};

const withdrawFunds = async (amount, account) => {
  try {
    const transfer = new PayDunya.Transfer();
    const response = await transfer.send(amount, account);
    return response;
  } catch (error) {
    throw new Error(`Failed to withdraw funds: ${error.message}`);
  }
};

const automateOwnerShareTransfer = async (amount) => {
  try {
    const ownerAccount = process.env.PAYDUNYA_OWNER_ACCOUNT;
    const response = await withdrawFunds(amount, ownerAccount);
    console.log('Owner share transferred successfully:', response);
  } catch (error) {
    console.error('Error during owner share transfer:', error.message);
  }
};

module.exports = {
  setupPayDunya,
  createInvoice,
  withdrawFunds,
  automateOwnerShareTransfer,
};