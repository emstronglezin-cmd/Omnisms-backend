const subscriptionMiddleware = (req, res, next) => {
  const userSubscription = req.user.subscription; // Mocked for now

  if (!userSubscription || !userSubscription.isActive) {
    return res.status(403).json({ error: 'Subscription required to access this feature.' });
  }

  next();
};

module.exports = subscriptionMiddleware;