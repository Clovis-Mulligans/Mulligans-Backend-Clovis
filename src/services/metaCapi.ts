// src/services/metaCapi.ts
import crypto from 'crypto';

const META_API_VERSION = 'v18.0';
const IOS_BUNDLE_ID = 'com.mulligansgolf.app';

let envWarningLogged = false;

interface MetaPurchaseEventParams {
  orderId: string;
  amount: number;
  currency: 'GBP';
  buyerEmail: string;
  clientIp?: string;
  userAgent?: string;
  eventTime?: number;
  testEventCode?: string;
}

export function sendMetaPurchaseEvent(params: MetaPurchaseEventParams): void {
  setImmediate(() => {
    _sendMetaPurchaseEvent(params).catch(err => {
      console.error('[META_CAPI] Failed:', err.message);
    });
  });
}

async function _sendMetaPurchaseEvent(params: MetaPurchaseEventParams): Promise<void> {
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const datasetId = process.env.META_DATASET_ID;

  if (!accessToken || !datasetId) {
    if (!envWarningLogged) {
      console.warn('[META_CAPI] Missing META_CAPI_ACCESS_TOKEN or META_DATASET_ID — skipping CAPI events');
      envWarningLogged = true;
    }
    return;
  }

  const hashedEmail = crypto
    .createHash('sha256')
    .update(params.buyerEmail.trim().toLowerCase())
    .digest('hex');

  const eventTime = params.eventTime ?? Math.floor(Date.now() / 1000);

  const userData: Record<string, any> = {
    em: [hashedEmail],
  };
  if (params.clientIp) {
    userData.client_ip_address = params.clientIp;
  }
  if (params.userAgent) {
    userData.client_user_agent = params.userAgent;
  }

  const body: Record<string, any> = {
    data: [
      {
        event_name: 'Purchase',
        event_time: eventTime,
        action_source: 'app',
        event_id: params.orderId,
        user_data: userData,
        app_data: {
          advertiser_tracking_enabled: 1,
          application_tracking_enabled: 1,
          extinfo: [
            'a2',
            IOS_BUNDLE_ID,
            '', '', '', '', '', '', '', '', '', '', '', '', '', '',
          ],
        },
        custom_data: {
          currency: params.currency,
          value: params.amount,
          content_ids: [params.orderId],
          content_type: 'product',
        },
      },
    ],
  };

  if (params.testEventCode) {
    body.test_event_code = params.testEventCode;
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${datasetId}/events?access_token=${accessToken}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  console.log('[META_CAPI] Purchase event sent for order:', params.orderId);
}
