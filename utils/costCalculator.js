const calculateCost = (unitCost, markupPercent) => {
  const markup = (unitCost * markupPercent) / 100;
  return unitCost + markup;
};

module.exports = { calculateCost };