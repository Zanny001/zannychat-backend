const { SignedDataVerifier, Environment } = require('@apple/app-store-server-library');

function rootCertificates(value = process.env.APPLE_ROOT_CA_CERTIFICATES_BASE64) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Apple root certificates are not configured');
  }
  const certificates = value.split(',').map((part) => Buffer.from(part.trim(), 'base64'));
  if (!certificates.length || certificates.some((certificate) => certificate.length < 256)) {
    throw new Error('Apple root certificate configuration is invalid');
  }
  return certificates;
}

function createAppleStoreVerifier({
  bundleId = process.env.APPLE_APP_BUNDLE_ID,
  appAppleId = process.env.APPLE_APP_ID,
  roots = process.env.APPLE_ROOT_CA_CERTIFICATES_BASE64,
  allowSandbox = process.env.APPLE_IAP_ALLOW_SANDBOX === 'true',
} = {}) {
  if (typeof bundleId !== 'string' || !bundleId.trim()) {
    throw new Error('Apple app bundle identifier is not configured');
  }
  const certificates = rootCertificates(roots);
  const productionAppId = Number(appAppleId);
  if (!Number.isSafeInteger(productionAppId) || productionAppId <= 0) {
    throw new Error('Apple numeric app identifier is not configured');
  }
  const production = new SignedDataVerifier(
    certificates, true, Environment.PRODUCTION, bundleId, productionAppId,
  );
  const sandbox = allowSandbox
    ? new SignedDataVerifier(certificates, true, Environment.SANDBOX, bundleId, undefined)
    : null;

  return {
    async verifyTransaction(signedTransaction) {
      try {
        const transaction = await production.verifyAndDecodeTransaction(signedTransaction);
        return { transaction, environment: 'Production' };
      } catch (productionError) {
        if (!sandbox) throw productionError;
        const transaction = await sandbox.verifyAndDecodeTransaction(signedTransaction);
        return { transaction, environment: 'Sandbox' };
      }
    },
    async verifyNotification(signedPayload) {
      try {
        const notification = await production.verifyAndDecodeNotification(signedPayload);
        return { notification, environment: 'Production' };
      } catch (productionError) {
        if (!sandbox) throw productionError;
        const notification = await sandbox.verifyAndDecodeNotification(signedPayload);
        return { notification, environment: 'Sandbox' };
      }
    },
  };
}

function appleBillingConfigured() {
  return process.env.LIVE_APPLE_IAP_ENABLED === 'true'
    && Boolean(process.env.APPLE_APP_BUNDLE_ID)
    && Boolean(process.env.APPLE_APP_ID)
    && Boolean(process.env.APPLE_ROOT_CA_CERTIFICATES_BASE64);
}

function minorUnitsFromApplePrice(priceMilliunits, currency) {
  if (currency !== 'NGN' || !Number.isSafeInteger(Number(priceMilliunits))
      || Number(priceMilliunits) <= 0 || Number(priceMilliunits) % 10 !== 0) {
    throw new Error('Apple transaction price is not a supported NGN amount');
  }
  const amountMinor = Number(priceMilliunits) / 10;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Apple transaction price is outside the supported range');
  }
  return amountMinor;
}

module.exports = {
  createAppleStoreVerifier,
  appleBillingConfigured,
  minorUnitsFromApplePrice,
  rootCertificates,
};
