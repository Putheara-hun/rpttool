// Deterministic sample data sets used by the designer and the sample reports.
import type { Row } from '../model/types';

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS: [string, string, number][] = [
  ['Chai', 'Beverages', 18],
  ['Chang', 'Beverages', 19],
  ['Lakkalikoori', 'Beverages', 18],
  ['Steeleye Stout', 'Beverages', 18],
  ['Cote de Blaye', 'Beverages', 263.5],
  ['Aniseed Syrup', 'Condiments', 10],
  ['Cajun Seasoning', 'Condiments', 22],
  ['Northwoods Cranberry Sauce', 'Condiments', 40],
  ['Genen Shouyu', 'Condiments', 15.5],
  ['Pavlova', 'Confections', 17.45],
  ['Teatime Chocolate Biscuits', 'Confections', 9.2],
  ['Sir Rodney\'s Scones', 'Confections', 10],
  ['Schoggi Schokolade', 'Confections', 43.9],
  ['Queso Cabrales', 'Dairy Products', 21],
  ['Queso Manchego', 'Dairy Products', 38],
  ['Gorgonzola Telino', 'Dairy Products', 12.5],
  ['Mascarpone Fabioli', 'Dairy Products', 32],
  ['Gustaf\'s Knackebrod', 'Grains/Cereals', 21],
  ['Tunnbrod', 'Grains/Cereals', 9],
  ['Ravioli Angelo', 'Grains/Cereals', 19.5],
  ['Mishi Kobe Niku', 'Meat/Poultry', 97],
  ['Alice Mutton', 'Meat/Poultry', 39],
  ['Perth Pasties', 'Meat/Poultry', 32.8],
  ['Tofu', 'Produce', 23.25],
  ['Dried Pears', 'Produce', 30],
  ['Manjimup Dried Apples', 'Produce', 53],
  ['Ikura', 'Seafood', 31],
  ['Konbu', 'Seafood', 6],
  ['Carnarvon Tigers', 'Seafood', 62.5],
  ['Boston Crab Meat', 'Seafood', 18.4],
];

const SUPPLIERS = ['Exotic Liquids', 'Tokyo Traders', 'Pavlova Ltd.', 'Mayumi\'s', 'Leka Trading', 'Nord-Ost-Fisch', 'Formaggi Fortini', 'Mekong Fresh Co.'];

const CUSTOMERS: [string, string, string, string][] = [
  ['Alpine Traders', 'Anna Keller', 'Berlin', 'Germany'],
  ['Blue Harbor Foods', 'Mark Johnson', 'Seattle', 'USA'],
  ['Cedar Market', 'Laura Smith', 'Boston', 'USA'],
  ['Delta Gourmet', 'Pierre Martin', 'Paris', 'France'],
  ['Eastwind Imports', 'Kenji Sato', 'Tokyo', 'Japan'],
  ['Fjord Delikatessen', 'Ingrid Olsen', 'Oslo', 'Norway'],
  ['Golden Lotus Mart', 'Sokha Chan', 'Phnom Penh', 'Cambodia'],
  ['Harbor View Cafe', 'Emily Brown', 'London', 'UK'],
  ['Island Provisions', 'Liam Wilson', 'Sydney', 'Australia'],
  ['Jardim Alimentos', 'Ana Souza', 'Sao Paulo', 'Brazil'],
  ['Kingsway Grocers', 'Oliver Taylor', 'Manchester', 'UK'],
  ['Lotus Garden Supply', 'Dara Pich', 'Siem Reap', 'Cambodia'],
  ['Maple Leaf Foods', 'Chloe Tremblay', 'Montreal', 'Canada'],
  ['Northern Lights Deli', 'Erik Lund', 'Stockholm', 'Sweden'],
  ['Oceanic Seafood Co.', 'Hiro Tanaka', 'Osaka', 'Japan'],
  ['Prairie Pantry', 'Jacob Miller', 'Chicago', 'USA'],
  ['Riviera Fine Foods', 'Giulia Rossi', 'Milan', 'Italy'],
  ['Sunrise Wholesale', 'Mei Lin', 'Singapore', 'Singapore'],
];

const SALES = ['Nancy Davolio', 'Andrew Fuller', 'Janet Leverling', 'Margaret Peacock', 'Steven Buchanan', 'Michael Suyama'];

let ordersCache: Row[] | null = null;
export function ordersData(): Row[] {
  if (ordersCache) return ordersCache.map((r) => ({ ...r }));
  const rnd = rng(42);
  const rows: Row[] = [];
  let orderId = 10248;
  const start = new Date(2025, 0, 2).getTime();
  for (let o = 0; o < 90; o++) {
    const cust = CUSTOMERS[Math.floor(rnd() * CUSTOMERS.length)];
    const date = new Date(start + Math.floor(rnd() * 360) * 86400000);
    const sales = SALES[Math.floor(rnd() * SALES.length)];
    const lines = 1 + Math.floor(rnd() * 4);
    const freight = Math.round(rnd() * 12000) / 100;
    const shipped = rnd() > 0.15;
    const used = new Set<number>();
    for (let l = 0; l < lines; l++) {
      let pi = Math.floor(rnd() * PRODUCTS.length);
      while (used.has(pi)) pi = (pi + 1) % PRODUCTS.length;
      used.add(pi);
      const [name, cat, price] = PRODUCTS[pi];
      const qty = 1 + Math.floor(rnd() * 40);
      const disc = rnd() > 0.7 ? [0.05, 0.1, 0.15, 0.2][Math.floor(rnd() * 4)] : 0;
      rows.push({
        OrderID: orderId,
        OrderDate: new Date(date),
        CustomerName: cust[0],
        ContactName: cust[1],
        City: cust[2],
        Country: cust[3],
        Salesperson: sales,
        CategoryName: cat,
        ProductName: name,
        Quantity: qty,
        UnitPrice: price,
        Discount: disc,
        Amount: Math.round(qty * price * (1 - disc) * 100) / 100,
        Freight: freight,
        Shipped: shipped,
      });
    }
    orderId++;
  }
  rows.sort((a, b) => (a.OrderDate as Date).getTime() - (b.OrderDate as Date).getTime());
  ordersCache = rows;
  return rows.map((r) => ({ ...r }));
}

export function productsData(): Row[] {
  const rnd = rng(7);
  return PRODUCTS.map(([name, cat, price], i) => ({
    ProductID: i + 1,
    ProductName: name,
    CategoryName: cat,
    Supplier: SUPPLIERS[i % SUPPLIERS.length],
    UnitPrice: price,
    UnitsInStock: Math.floor(rnd() * 120),
    ReorderLevel: [0, 5, 10, 15, 25][Math.floor(rnd() * 5)],
    Discontinued: rnd() > 0.85,
  }));
}

export function customersData(): Row[] {
  return CUSTOMERS.map(([company, contact, city, country], i) => ({
    CustomerID: 'C' + String(i + 1).padStart(3, '0'),
    CompanyName: company,
    ContactName: contact,
    City: city,
    Country: country,
    Phone: `+${10 + i} ${100 + i * 7} ${2000 + i * 113}`,
    Email: contact.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com',
  }));
}

export function employeesData(): Row[] {
  const rnd = rng(99);
  const titles = ['Sales Representative', 'Vice President, Sales', 'Sales Representative', 'Sales Manager', 'Inside Sales Coordinator', 'Sales Representative'];
  const deps = ['Sales', 'Management', 'Sales', 'Sales', 'Operations', 'Sales'];
  return SALES.map((n, i) => {
    const [first, last] = n.split(' ');
    return {
      EmployeeID: i + 1,
      FirstName: first,
      LastName: last,
      Title: titles[i],
      Department: deps[i],
      HireDate: new Date(2012 + Math.floor(rnd() * 10), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27)),
      BirthDate: new Date(1965 + Math.floor(rnd() * 30), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27)),
      City: ['Seattle', 'Tacoma', 'Kirkland', 'Redmond', 'London', 'London'][i],
      Salary: 42000 + Math.round(rnd() * 60) * 1000,
    };
  });
}

export const SAMPLE_SETS: Record<string, { label: string; load: () => Row[] }> = {
  orders: { label: 'Sales Orders (order lines)', load: ordersData },
  products: { label: 'Products', load: productsData },
  customers: { label: 'Customers', load: customersData },
  employees: { label: 'Employees', load: employeesData },
};
