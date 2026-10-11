pragma solidity ^0.8.19;
interface Wrapped { function deposit() external payable; function withdraw(uint256) external; function balanceOf(address) external view returns (uint256); }
contract WrapAudit {
  receive() external payable {}
  function roundTrip(address token) external payable returns (uint256) {
    uint256 beforeTokens = Wrapped(token).balanceOf(address(this));
    uint256 beforeNative = address(this).balance;
    Wrapped(token).deposit{value:msg.value}();
    require(Wrapped(token).balanceOf(address(this)) - beforeTokens == msg.value, "WRAP_AMOUNT");
    Wrapped(token).withdraw(msg.value);
    require(Wrapped(token).balanceOf(address(this)) == beforeTokens, "UNWRAP_AMOUNT");
    require(address(this).balance == beforeNative, "NATIVE_RECEIPT");
    return msg.value;
  }
}
interface TaoVault { function depositLiquid(address token, uint256 minAlphaRao) external payable returns(uint256); function withdrawLiquid(address token,uint256 wad,uint256 minTaoOut) external returns(uint256); }
contract TaoWrapAudit {
 receive() external payable {}
 function roundTrip(address vault,address token) external payable returns(uint256){
  uint256 beforeTokens=Wrapped(token).balanceOf(address(this)); uint256 beforeNative=address(this).balance;
  require(TaoVault(vault).depositLiquid{value:msg.value}(token,msg.value / 1e9)==msg.value,"WRAP_AMOUNT");
  require(Wrapped(token).balanceOf(address(this))-beforeTokens==msg.value,"WRAP_BALANCE");
  require(TaoVault(vault).withdrawLiquid(token,msg.value,msg.value)==msg.value,"UNWRAP_AMOUNT");
  require(Wrapped(token).balanceOf(address(this))==beforeTokens,"UNWRAP_BALANCE");
  require(address(this).balance==beforeNative,"NATIVE_RECEIPT"); return msg.value;
 }
}
