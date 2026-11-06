// Products (group what belongs together) and client spaces: pages, pop-ups, and pieces other pages mount.
export { ClientsPage, ClientModal, ClientForm, ClientAvatar, ClientFilter, MoveToClientDialog, moveToClientItem } from './Clients';
export { ProductsPage, GroupSuggestions, GroupReview, ProductModal } from './Products';
export { useClients, useClientFilter, pickClient, reloadClients, type Client, type ClientList, type MapGroup, type Product, type GroupSuggestion } from './data';
