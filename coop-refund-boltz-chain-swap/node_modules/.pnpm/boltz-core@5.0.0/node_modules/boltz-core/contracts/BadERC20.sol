// SPDX-License-Identifier: MIT

pragma solidity ^0.8.33;

// This token is intentionally not complying to the ERC20 standard so that the ERC20Swap contract
// can be tested against such non-standardised tokens
//
// Reference: https://medium.com/coinmonks/missing-return-value-bug-at-least-130-tokens-affected-d67bf08521ca
interface IBadERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 value) external;

    function transfer(address recipient, uint256 amount) external;
    function transferFrom(address sender, address recipient, uint256 amount) external;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
}

contract BadERC20 is IBadERC20 {
    error InsufficientAllowance();
    error InsufficientBalance();
    error ApproveFromZeroAddress();
    error ApproveToZeroAddress();
    error TransferFromZeroAddress();
    error TransferToZeroAddress();

    uint8 public decimals;

    mapping(address => uint256) private _balances;

    mapping(address => mapping(address => uint256)) private _allowances;

    string private _name;
    string private _symbol;

    constructor(string memory name, string memory symbol, uint8 _decimals, uint256 initialSupply) {
        decimals = _decimals;

        _name = name;
        _symbol = symbol;

        _balances[msg.sender] = _balances[msg.sender] + initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) public view override returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) public override {
        _approve(msg.sender, spender, amount);
    }

    function transfer(address recipient, uint256 amount) public override {
        _transfer(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) external override {
        _transfer(sender, recipient, amount);

        uint256 currentAllowance = _allowances[sender][msg.sender];
        require(currentAllowance >= amount, InsufficientAllowance());
        _approve(sender, msg.sender, currentAllowance - amount);
    }

    function _approve(address owner, address spender, uint256 amount) internal {
        require(owner != address(0), ApproveFromZeroAddress());
        require(spender != address(0), ApproveToZeroAddress());

        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function _transfer(address sender, address recipient, uint256 amount) internal {
        require(sender != address(0), TransferFromZeroAddress());
        require(recipient != address(0), TransferToZeroAddress());

        uint256 senderBalance = _balances[sender];
        require(senderBalance >= amount, InsufficientBalance());
        _balances[sender] = senderBalance - amount;
        _balances[recipient] += amount;

        emit Transfer(sender, recipient, amount);
    }
}
