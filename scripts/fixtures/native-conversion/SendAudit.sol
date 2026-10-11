pragma solidity ^0.8.19;
import "./WrapAudit.sol";
interface Token { function approve(address,uint256) external returns(bool); }
interface Router {
 struct TokenAmount { address token; uint256 amount; }
 struct Message { bytes receiver; bytes data; TokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }
 function getFee(uint64,Message calldata) external view returns(uint256);
 function ccipSend(uint64,Message calldata) external payable returns(bytes32);
}
contract SendAudit {
 receive() external payable {}
 function wrapAndSend(address token,address vault,address router,uint64 selector,address recipient,uint256 amount) external payable returns(bytes32) {
  uint256 beforeTokens=Wrapped(token).balanceOf(address(this));
  if(vault==address(0)) Wrapped(token).deposit{value:amount}();
  else require(TaoVault(vault).depositLiquid{value:amount}(token,amount/1e9)==amount,"WRAP_AMOUNT");
  require(Wrapped(token).balanceOf(address(this))-beforeTokens==amount,"WRAP_BALANCE");
  require(Token(token).approve(router,amount),"APPROVE");
  Router.TokenAmount[] memory amounts=new Router.TokenAmount[](1);amounts[0]=Router.TokenAmount(token,amount);
  Router.Message memory message=Router.Message(abi.encode(recipient),"",amounts,address(0),abi.encodeWithSelector(bytes4(0x181dcf10),uint256(0),true));
  uint256 fee=Router(router).getFee(selector,message);
  require(msg.value>=amount+fee,"FEE");
  bytes32 id=Router(router).ccipSend{value:fee}(selector,message);
  require(Wrapped(token).balanceOf(address(this))==beforeTokens,"BRIDGE_AMOUNT");
  return id;
 }
}
