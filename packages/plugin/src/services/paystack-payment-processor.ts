import crypto from "crypto";

import Paystack, { PaystackTransactionAuthorisation } from "../lib/paystack";

import {
  PaymentProcessorContext,
  PaymentProcessorError,
  PaymentProcessorSessionResponse,
  MedusaContainer,
  ICartModuleService,
  WebhookActionResult,
} from "@medusajs/types";
import {
  MedusaError,
  MedusaErrorTypes,
  PaymentSessionStatus,
  AbstractPaymentProvider,
  PaymentActions,
} from "@medusajs/framework/dist/utils";
import { formatCurrencyCode } from "../utils/currencyCode";

export interface PaystackPaymentProcessorConfig
  extends Record<string, unknown> {
  /**
   * Paystack Secret Key
   *
   * Should be in the format sk_test-... or sk_live-...
   *
   * Obtainable from the Paystack dashboard - Settings -> API Keys & Webhooks
   *
   * https://dashboard.paystack.com/#/settings/developers
   */
  secret_key: string;

  /**
   * Disable retries on network errors and 5xx errors on idempotent requests to Paystack
   *
   * Generally, you should not disable retries, these errors are usually temporary
   * but it can be useful for debugging
   * @default false
   */
  disable_retries?: boolean;

  /**
   * Debug mode
   * If true, logs helpful debug information to the console
   * Logs are prefixed with "PS_P_Debug"
   */
  debug?: boolean;
}

class PaystackPaymentProcessor extends AbstractPaymentProvider {
  static identifier = "paystack";

  protected readonly cartService: ICartModuleService;
  protected readonly configuration: PaystackPaymentProcessorConfig;
  protected readonly paystack: Paystack;
  protected readonly debug: boolean;

  constructor(
    container: Record<string, any> & MedusaContainer,
    options: PaystackPaymentProcessorConfig,
  ) {
    super(container, options);

    if (!options.secret_key) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "The Paystack provider requires the secret_key option",
      );
    }

    this.configuration = options;
    this.paystack = new Paystack(this.configuration.secret_key, {
      disable_retries: options.disable_retries,
    });
    this.debug = Boolean(options.debug);

    // Container is just an object - https://docs.medusajs.com/development/fundamentals/dependency-injection#in-classes
    this.cartService = container.cartService;

    if (this.cartService.retrieveCart === undefined) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Your Medusa installation contains an unsupported cartService implementation. Update your Medusa installation.",
      );
    }
  }

  get paymentIntentOptions() {
    return {};
  }

  /**
   * Called when a user selects Paystack as their payment method during checkout
   */
  async initiatePayment(context: PaymentProcessorContext): Promise<
    | PaymentProcessorError
    | (PaymentProcessorSessionResponse & {
        session_data: {
          paystackTxRef: string;
          paystackTxAuthData: PaystackTransactionAuthorisation;
          cartId: string;
        };
      })
  > {
    if (this.debug) {
      console.info(
        "PS_P_Debug: InitiatePayment",
        JSON.stringify(context, null, 2),
      );
    }

    const { amount, email, currency_code } = context;

    const validatedCurrencyCode = formatCurrencyCode(currency_code);

    const { data, status, message } =
      await this.paystack.transaction.initialize({
        amount: amount, // Paystack expects amount in lowest denomination - https://paystack.com/docs/payments/accept-payments/#initialize-transaction-1
        email,
        currency: validatedCurrencyCode,
        metadata: {
          cart_id: context.resource_id,
        },
      });

    if (status === false) {
      return this.buildError("Failed to initiate Paystack payment", {
        detail: message,
      });
    }

    return {
      session_data: {
        paystackTxRef: data.reference,
        paystackTxAuthData: data,
        cartId: context.resource_id,
      },
    };
  }

  /**
   * Called when a user updates their cart after `initiatePayment` has been called
   */
  async updatePaymentData(
    _: string,
    data: Record<string, unknown>,
  ): Promise<
    PaymentProcessorSessionResponse["session_data"] | PaymentProcessorError
  > {
    if (this.debug) {
      console.info(
        "PS_P_Debug: UpdatePaymentData",
        JSON.stringify({ _, data }, null, 2),
      );
    }

    if (data.amount) {
      throw new MedusaError(
        MedusaErrorTypes.INVALID_DATA,
        "Cannot update amount from updatePaymentData",
      );
    }

    return {
      session_data: {
        ...data, // We just return the data as is
      },
    };
  }

  /**
   * Called when a cart item is added or shipping address is updated
   */
  async updatePayment(context: PaymentProcessorContext): Promise<
    | PaymentProcessorError
    | (PaymentProcessorSessionResponse & {
        session_data: {
          paystackTxRef: string;
        };
      })
  > {
    if (this.debug) {
      console.info(
        "PS_P_Debug: UpdatePayment",
        JSON.stringify(context, null, 2),
      );
    }

    // Re-initialize the payment
    return this.initiatePayment(context);
  }

  /**
   * Called when a cart is completed
   * We validate the payment and return a status
   */
  async authorizePayment(
    paymentSessionData: Record<string, unknown> & {
      paystackTxRef: string;
      cartId: string;
    },
  ): Promise<
    | PaymentProcessorError
    | {
        status: PaymentSessionStatus;
        data: Record<string, unknown>;
      }
  > {
    if (this.debug) {
      console.info(
        "PS_P_Debug: AuthorizePayment",
        JSON.stringify(paymentSessionData, null, 2),
      );
    }

    try {
      const { paystackTxRef } = paymentSessionData;

      const { status, data } = await this.paystack.transaction.verify({
        reference: paystackTxRef,
      });

      if (this.debug) {
        console.info(
          "PS_P_Debug: AuthorizePayment: Verification",
          JSON.stringify({ status, data }, null, 2),
        );
      }

      if (status === false) {
        // Invalid key error
        return {
          status: PaymentSessionStatus.ERROR,
          data: {
            ...paymentSessionData,
            paystackTxId: null,
            paystackTxData: data,
          },
        };
      }

      switch (data.status) {
        case "success": {
          // Successful transaction
          return {
            status: PaymentSessionStatus.AUTHORIZED,
            data: {
              paystackTxId: data.id,
              paystackTxData: data,
            },
          };
        }

        case "failed":
          // Failed transaction
          return {
            status: PaymentSessionStatus.ERROR,
            data: {
              ...paymentSessionData,
              paystackTxId: data.id,
              paystackTxData: data,
            },
          };

        default:
          // Pending transaction
          return {
            status: PaymentSessionStatus.PENDING,
            data: paymentSessionData,
          };
      }
    } catch (error) {
      return this.buildError("Failed to authorize payment", error);
    }
  }

  /**
   * Retrieve transaction data from Paystack.
   */
  async retrievePayment(
    paymentSessionData: Record<string, unknown> & { paystackTxId: string },
  ): Promise<Record<string, unknown> | PaymentProcessorError> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: RetrievePayment",
        JSON.stringify(paymentSessionData, null, 2),
      );
    }

    try {
      const { paystackTxId } = paymentSessionData;

      const { data, status, message } = await this.paystack.transaction.get({
        id: paystackTxId,
      });

      if (status === false) {
        return this.buildError("Failed to retrieve payment", {
          detail: message,
        });
      }

      return {
        ...paymentSessionData,
        paystackTxData: data,
      };
    } catch (error) {
      return this.buildError("Failed to retrieve payment", error);
    }
  }

  /**
   * Refunds payment for Paystack transaction
   */
  async refundPayment(
    paymentSessionData: Record<string, unknown> & { paystackTxId: number },
    refundAmount: number,
  ): Promise<Record<string, unknown> | PaymentProcessorError> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: RefundPayment",
        JSON.stringify({ paymentSessionData, refundAmount }, null, 2),
      );
    }

    try {
      const { paystackTxId } = paymentSessionData;

      const { data, status, message } = await this.paystack.refund.create({
        transaction: paystackTxId,
        amount: refundAmount,
      });

      if (status === false) {
        return this.buildError("Failed to refund payment", {
          detail: message,
        });
      }

      return {
        ...paymentSessionData,
        paystackTxData: data,
      };
    } catch (error) {
      return this.buildError("Failed to refund payment", error);
    }
  }

  /**
   * Returns Paystack transaction status
   */
  async getPaymentStatus(
    paymentSessionData: Record<string, unknown> & { paystackTxId?: string },
  ): Promise<PaymentSessionStatus> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: GetPaymentStatus",
        JSON.stringify(paymentSessionData, null, 2),
      );
    }

    const { paystackTxId } = paymentSessionData;

    if (!paystackTxId) {
      return PaymentSessionStatus.PENDING;
    }

    try {
      const { data, status } = await this.paystack.transaction.get({
        id: paystackTxId,
      });

      if (status === false) {
        return PaymentSessionStatus.ERROR;
      }

      switch (data?.status) {
        case "success":
          return PaymentSessionStatus.AUTHORIZED;
        case "failed":
          return PaymentSessionStatus.ERROR;
        default:
          return PaymentSessionStatus.PENDING;
      }
    } catch (error) {
      return PaymentSessionStatus.ERROR;
    }
  }

  /**
   * Marks payment as captured. Transactions are 'captured' by default in Paystack.
   * So this just returns the payment session data.
   */
  async capturePayment(
    paymentSessionData: Record<string, unknown>,
  ): Promise<Record<string, unknown> | PaymentProcessorError> {
    return paymentSessionData;
  }

  /**
   * Cancel payment for Paystack payment intent.
   * This is not supported by Paystack - transactions are stateless.
   */
  async cancelPayment(
    paymentSessionData: Record<string, unknown>,
  ): Promise<Record<string, unknown> | PaymentProcessorError> {
    return paymentSessionData;
  }

  /**
   * Delete payment for Paystack payment intent.
   * This is not supported by Paystack - transactions are stateless.
   */
  async deletePayment(
    paymentSessionData: Record<string, unknown>,
  ): Promise<Record<string, unknown> | PaymentProcessorError> {
    return paymentSessionData;
  }

  protected buildError(
    message: string,
    e:
      | {
          code?: string;
          detail: string;
        }
      | Error,
  ): PaymentProcessorError {
    const errorMessage = "Paystack Payment error: " + message;
    const code = e instanceof Error ? e.message : e.code;
    const detail = e instanceof Error ? e.stack : e.detail;

    return {
      error: errorMessage,
      code: code ?? "",
      detail: detail ?? "",
    };
  }

  async getWebhookActionAndData({
    data,
    rawData,
    headers,
  }: {
    data: {
      event: string;
      amount: number;
      metadata?: Record<string, any>;
    };
    rawData: string | Buffer;
    headers: Record<string, unknown>;
  }): Promise<WebhookActionResult> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: Handling webhook event",
        JSON.stringify({ data, rawData, headers }, null, 2),
      );
    }

    const webhookSecretKey = this.configuration.secret_key;

    if (!webhookSecretKey) {
      console.error("PS_P_Debug: No secret key provided for Paystack plugin");

      return {
        action: PaymentActions.NOT_SUPPORTED,
      };
    }

    // Validate webhook event
    const hash = crypto
      .createHmac("sha512", webhookSecretKey)
      .update(rawData)
      .digest("hex");

    if (hash !== headers["x-paystack-signature"]) {
      return {
        action: PaymentActions.NOT_SUPPORTED,
      };
    }

    // Validate event type
    if (data.event !== "charge.success") {
      return {
        action: PaymentActions.NOT_SUPPORTED,
      };
    }

    const cartId = data.metadata?.cart_id;

    if (!cartId) {
      console.error(
        "PS_P_Debug: No cart_id found in webhook transaction metadata",
      );
      return {
        action: PaymentActions.NOT_SUPPORTED,
      };
    }

    return {
      action: PaymentActions.AUTHORIZED,
      data: {
        session_id: cartId,
        amount: data.amount,
      },
    };
  }
}

export default PaystackPaymentProcessor;
