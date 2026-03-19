> /**
>  * 📉 OmniSMS - SMS Quota Manager
>  * 5 SMS gratuits / jour pour non-premium
>  */
> function checkSmsQuota(user) {
>   const today = new Date().toDateString();
>
>   if (user.smsQuotaDate !== today) {
>     user.smsQuotaDate = today;
>     user.smsQuotaCount = 0;
>   }
>
>   if (!user.isPremium && user.smsQuotaCount >= 5) {
>     throw new Error('Quota SMS quotidien dépassé');
>   }
>
>   user.smsQuotaCount += 1;
> }
>
> module.exports = { checkSmsQuota };
