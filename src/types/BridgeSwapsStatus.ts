export enum LdsSwapStatus {
  // Pending statuses
  InvoiceSet = "invoice.set",
  InvoicePending = "invoice.pending",
  SwapCreated = "swap.created",
  TransactionConfirmed = "transaction.confirmed",
  TransactionMempool = "transaction.mempool",
  TransactionZeroConfRejected = "transaction.zeroconf.rejected",
  TransactionClaimPending = "transaction.claim.pending",
  TransactionServerMempool = "transaction.server.mempool",
  TransactionServerConfirmed = "transaction.server.confirmed",
  // Failed statuses
  SwapExpired = "swap.expired",
  SwapRefunded = "swap.refunded",
  SwapWaitingForRefund = "swap.waitingForRefund",
  InvoiceExpired = "invoice.expired",
  InvoiceFailedToPay = "invoice.failedToPay",
  TransactionFailed = "transaction.failed",
  TransactionLockupFailed = "transaction.lockupFailed",
  TransactionRefunded = "transaction.refunded",
  // Success statuses
  InvoiceSettled = "invoice.settled",
  TransactionClaimed = "transaction.claimed",

  // Local user statuses (not from LDS)
  UserRefunded = "local.userRefunded",
  UserClaimed = "local.userClaimed",
  UserAbandoned = "local.userAbandoned",
  UserClaimable = "local.userClaimable",
  UserRefundable = "local.userRefundable",
}

export const swapStatusPending = {
  InvoiceSet: LdsSwapStatus.InvoiceSet,
  InvoicePending: LdsSwapStatus.InvoicePending,
  SwapCreated: LdsSwapStatus.SwapCreated,
  TransactionConfirmed: LdsSwapStatus.TransactionConfirmed,
  TransactionMempool: LdsSwapStatus.TransactionMempool,
  TransactionZeroConfRejected: LdsSwapStatus.TransactionZeroConfRejected,
  TransactionClaimPending: LdsSwapStatus.TransactionClaimPending,
  TransactionServerMempool: LdsSwapStatus.TransactionServerMempool,
  TransactionServerConfirmed: LdsSwapStatus.TransactionServerConfirmed,
};

export const swapStatusFailed = {
  SwapExpired: LdsSwapStatus.SwapExpired,
  SwapRefunded: LdsSwapStatus.SwapRefunded,
  SwapWaitingForRefund: LdsSwapStatus.SwapWaitingForRefund,
  InvoiceExpired: LdsSwapStatus.InvoiceExpired,
  InvoiceFailedToPay: LdsSwapStatus.InvoiceFailedToPay,
  TransactionFailed: LdsSwapStatus.TransactionFailed,
  TransactionLockupFailed: LdsSwapStatus.TransactionLockupFailed,
  TransactionRefunded: LdsSwapStatus.TransactionRefunded,
};

export const swapStatusSuccess = {
  InvoiceSettled: LdsSwapStatus.InvoiceSettled,
  TransactionClaimed: LdsSwapStatus.TransactionClaimed,
  UserClaimed: LdsSwapStatus.UserClaimed,
};

export const swapStatusFinal = [
  ...Object.values(swapStatusFailed),
  ...Object.values(swapStatusSuccess),
  LdsSwapStatus.UserRefunded,
  LdsSwapStatus.UserClaimed,
  LdsSwapStatus.UserAbandoned,
];

export const localUserFinalStatuses = [
  LdsSwapStatus.UserRefunded,
  LdsSwapStatus.UserClaimed,
  LdsSwapStatus.UserAbandoned,
];

export const trackStatuses = [...Object.values(swapStatusPending)];
