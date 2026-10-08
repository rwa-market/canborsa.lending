/**
 * Template and interface identifiers by package name (package-name reference). The Compound V3
 * model lives in new packages, lending-core-v2 and lending-governance-v2: their fields are not an
 * upgrade of lending-core.
 */
export const TEMPLATES = {
  config: '#lending-core-v2:Lending.Config:ProtocolConfig',
  pool: '#lending-core-v2:Lending.Pool:Pool',
  account: '#lending-core-v2:Lending.Account:Account',
  accountRequest: '#lending-core-v2:Lending.Account:AccountRequest',
  accountDirectory: '#lending-core-v2:Lending.Account:AccountDirectory',
  priceFeed: '#lending-core-v2:Lending.Oracle:PriceFeed',
  reserveAttestation: '#lending-core-v2:Lending.Oracle:ReserveAttestation',
  // Compound V3 model: pause flags the guardian controls (K7)
  pauseState: '#lending-core-v2:Lending.Pause:PauseState',
  login: '#lending-core-v2:Lending.Auth:Login',
  // lending-core 0.5.0: EVM wallet accounts under the custodian (ADR-004)
  evmWallet: '#lending-core-v2:Lending.Evm:EvmWallet',
  evmDirectory: '#lending-core-v2:Lending.Account:EvmDirectory',
  // lending-core 0.6.0: request to withdraw USDCx to Ethereum (real assets)
  redeemRequest: '#lending-core-v2:Lending.EvmRedeem:RedeemRequest',
  // registry of the custodian's credited deposits and the credit record (EvmWallet_CreditDeposit)
  depositRegistry: '#lending-core-v2:Lending.EvmDeposit:DepositRegistry',
  depositClaim: '#lending-core-v2:Lending.EvmDeposit:DepositClaim',
  // lending-core 0.7.0: Loop wallet accounts under the custodian
  loopWallet: '#lending-core-v2:Lending.Loop:LoopWallet',
  loopDirectory: '#lending-core-v2:Lending.Loop:LoopDirectory',
  // lending-governance 0.4.0: council, proposals, council rotation and income withdrawal
  governanceCouncil: '#lending-governance-v2:Lending.Governance:GovernanceCouncil',
  parameterChangeProposal: '#lending-governance-v2:Lending.Governance:ParameterChangeProposal',
  councilRotation: '#lending-governance-v2:Lending.Governance:CouncilRotation',
  incomeProposal: '#lending-governance-v2:Lending.Governance:IncomeProposal',
  // lending-governance 0.5.0: market listing by the council
  marketListingProposal: '#lending-governance-v2:Lending.Governance:MarketListingProposal',
  marketDelistingProposal: '#lending-governance-v2:Lending.Governance:MarketDelistingProposal',
  testTokenRules: '#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenRules',
  testToken: '#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:Token',
  testTokenTransferOffer:
    '#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenTransferOffer',
} as const

/** BitSafe Decentralization Manager (governance-core-v1, governance-action-v1). */
export const DECMAN = {
  rules: '#governance-core-v1:Governance.Rules:GovernanceRules',
  confirmation: '#governance-core-v1:Governance.Confirmation:GovernanceConfirmation',
  action: '#governance-action-v1:Governance.Action:GovernableAction',
} as const

export const INTERFACES = {
  holding: '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
  transferInstruction:
    '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction',
  transferFactory:
    '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
  featuredAppRight: '#splice-api-featured-app-v1:Splice.Api.FeaturedAppRightV1:FeaturedAppRight',
  activityMarker:
    '#splice-api-featured-app-v1:Splice.Api.FeaturedAppRightV1:FeaturedAppActivityMarker',
} as const
